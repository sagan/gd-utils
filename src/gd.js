const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const prompts = require("prompts");
const pLimit = require("p-limit");
const axios = require("@viegg/axios");
const HttpsProxyAgent = require("https-proxy-agent");
const { GoogleToken } = require("gtoken");
const handle_exit = require("signal-exit");

const {
  AUTH,
  USE_TRASH,
  RETRY_LIMIT,
  PARALLEL_LIMIT,
  TIMEOUT_BASE,
  TIMEOUT_MAX,
  LOG_DELAY,
  PAGE_SIZE,
  DEFAULT_TARGET
} = require("../config.loader");
const { db } = require("../db");
const { make_table, make_tg_table, make_html, summary } = require("./summary");

const FILE_EXCEED_MSG = "您的团队盘文件数已超限(40万)，停止复制";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const sleep = (ms) => new Promise((resolve, reject) => setTimeout(resolve, ms));
const { https_proxy } = process.env;
const axins = axios.create(
  https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {}
);

const SA_BATCH_SIZE = 50;
const SA_FILES = fs
  .readdirSync(path.join(__dirname, "../sa"))
  .filter((v) => v.endsWith(".json"));
SA_FILES.flag = 0;
let SA_TOKENS = get_sa_batch();

function get_sa_batch() {
  const new_flag = SA_FILES.flag + SA_BATCH_SIZE;
  const files = SA_FILES.slice(SA_FILES.flag, new_flag);
  SA_FILES.flag = new_flag;
  return files.map((filename) => {
    const gtoken = new GoogleToken({
      keyFile: path.join(__dirname, "../sa", filename),
      scope: ["https://www.googleapis.com/auth/drive"]
    });
    return { gtoken, expires: 0 };
  });
}

handle_exit(() => {
  // console.log('handle_exit running')
  const records = db
    .prepare("select id from task where status=?")
    .all("copying");
  records.forEach((v) => {
    db.prepare("update task set status=? where id=?").run("interrupt", v.id);
  });
  records.length && console.log(records.length, "task interrupted");
});

async function gen_count_body({ fid, type, update, service_account }) {
  async function update_info() {
    const info = await walk_and_save({ fid, update, service_account }); // 这一步已经将fid记录存入数据库中了
    const row = db.prepare("SELECT summary from gd WHERE fid=?").get(fid);
    if (!row) return [];
    return [info, JSON.parse(row.summary)];
  }

  function render_smy(smy, type) {
    if (!smy) {
      return;
    }
    if (["html", "curl", "tg"].includes(type)) {
      smy = typeof smy === "object" ? smy : JSON.parse(smy);
      const type_func = {
        html: make_html,
        curl: make_table,
        tg: make_tg_table
      };
      return type_func[type](smy);
    } else {
      // 默认输出json
      return typeof smy === "string" ? smy : JSON.stringify(smy);
    }
  }

  let info, smy;
  const record = db.prepare("SELECT * FROM gd WHERE fid = ?").get(fid);
  if (!record || update) {
    [info, smy] = await update_info();
  }
  if (type === "all") {
    info = info || get_all_by_fid(fid);
    if (!info) {
      // 说明上次统计过程中断了
      [info] = await update_info();
    }
    return info && JSON.stringify(info);
  }
  if (smy) return render_smy(smy, type);
  if (record && record.summary) return render_smy(record.summary, type);
  info = info || get_all_by_fid(fid);
  if (info) {
    smy = summary(info);
  } else {
    [info, smy] = await update_info();
  }
  return render_smy(smy, type);
}

async function count({
  fid,
  update,
  sort,
  type,
  output,
  not_teamdrive,
  service_account
}) {
  sort = (sort || "").toLowerCase();
  type = (type || "").toLowerCase();
  output = (output || "").toLowerCase();
  if (!update) {
    const info = get_all_by_fid(fid);
    if (info) {
      console.log("找到本地缓存数据，缓存时间：", dayjs(info.mtime).format());
      const out_str = get_out_str({ info, type, sort });
      if (output) return fs.writeFileSync(output, out_str);
      return console.log(out_str);
    }
  }
  const result = await walk_and_save({
    fid,
    not_teamdrive,
    update,
    service_account
  });
  const out_str = get_out_str({ info: result, type, sort });
  if (output) {
    fs.writeFileSync(output, out_str);
  } else {
    console.log(out_str);
  }
}

function get_out_str({ info, type, sort }) {
  const smy = summary(info, sort);
  let out_str;
  if (type === "html") {
    out_str = make_html(smy);
  } else if (type === "json") {
    out_str = JSON.stringify(smy);
  } else if (type === "all") {
    out_str = JSON.stringify(info);
  } else {
    out_str = make_table(smy);
  }
  return out_str;
}

function get_all_by_fid(fid) {
  const record = db.prepare("SELECT * FROM gd WHERE fid = ?").get(fid);
  if (!record) return null;
  const { info, subf } = record;
  let result = JSON.parse(info);
  result = result.map((v) => {
    v.parent = fid;
    return v;
  });
  if (!subf) return result;
  return recur(result, JSON.parse(subf));

  function recur(result, subf) {
    if (!subf.length) return result;
    const arr = subf.map((v) => {
      const row = db.prepare("SELECT * FROM gd WHERE fid = ?").get(v);
      if (!row) return null; // 如果没找到对应的fid记录，说明上次中断了进程或目录读取未完成
      let info = JSON.parse(row.info);
      info = info.map((vv) => {
        vv.parent = v;
        return vv;
      });
      return { info, subf: JSON.parse(row.subf) };
    });
    if (arr.some((v) => v === null)) return null;
    const sub_subf = [].concat(...arr.map((v) => v.subf).filter((v) => v));
    result = result.concat(...arr.map((v) => v.info));
    return recur(result, sub_subf);
  }
}

async function walk_and_save({ fid, not_teamdrive, update, service_account }) {
  const result = [];
  const not_finished = [];
  const limit = pLimit(PARALLEL_LIMIT);

  const loop = setInterval(() => {
    const now = dayjs().format("HH:mm:ss");
    const message = `${now} | 已获取对象 ${result.length} | 网络请求 进行中${
      limit.activeCount
    }/排队中${limit.pendingCount}`;
    print_progress(message);
  }, 1000);

  async function recur(parent) {
    let files, should_save;
    if (update) {
      files = await limit(() =>
        ls_folder({ fid: parent, not_teamdrive, service_account })
      );
      should_save = true;
    } else {
      const record = db.prepare("SELECT * FROM gd WHERE fid = ?").get(parent);
      if (record) {
        files = JSON.parse(record.info);
      } else {
        files = await limit(() =>
          ls_folder({ fid: parent, not_teamdrive, service_account })
        );
        should_save = true;
      }
    }
    if (!files) {
      return;
    }
    if (files.not_finished) {
      not_finished.push(parent);
    }
    should_save && save_files_to_db(parent, files);
    const folders = files.filter((v) => v.mimeType === FOLDER_TYPE);
    files.forEach((v) => (v.parent = parent));
    result.push(...files);
    return Promise.all(folders.map((v) => recur(v.id)));
  }
  try {
    await recur(fid);
  } catch (e) {
    console.error(e);
  }
  console.log("\n信息获取完毕");
  not_finished.length
    ? console.log("未读取完毕的目录ID：", JSON.stringify(not_finished))
    : console.log("所有目录读取完毕");
  clearInterval(loop);
  const smy = summary(result);
  db.prepare("UPDATE gd SET summary=?, mtime=? WHERE fid=?").run(
    JSON.stringify(smy),
    Date.now(),
    fid
  );
  return result;
}

function save_files_to_db(fid, files) {
  // 不保存请求未完成的目录，那么下次调用get_all_by_id会返回null，从而再次调用walk_and_save试图完成此目录的请求
  if (files.not_finished) return;
  let subf = files.filter((v) => v.mimeType === FOLDER_TYPE).map((v) => v.id);
  subf = subf.length ? JSON.stringify(subf) : null;
  const exists = db.prepare("SELECT fid FROM gd WHERE fid = ?").get(fid);
  if (exists) {
    db.prepare("UPDATE gd SET info=?, subf=?, mtime=? WHERE fid=?").run(
      JSON.stringify(files),
      subf,
      Date.now(),
      fid
    );
  } else {
    db.prepare(
      "INSERT INTO gd (fid, info, subf, ctime) VALUES (?, ?, ?, ?)"
    ).run(fid, JSON.stringify(files), subf, Date.now());
  }
}

async function ls_folder({ fid, not_teamdrive, service_account }) {
  let files = [];
  let pageToken;
  const search_all = {
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  };
  const params = fid === "root" || not_teamdrive ? {} : search_all;
  params.q = `'${fid}' in parents and trashed = false`;
  params.orderBy = "folder,name desc";
  params.fields = "nextPageToken, files(id, name, mimeType, size, md5Checksum)";
  params.pageSize = Math.min(PAGE_SIZE, 1000);
  const use_sa = fid !== "root" && (service_account || !not_teamdrive); // 不带参数默认使用sa
  const headers = await gen_headers(use_sa);
  do {
    if (pageToken) params.pageToken = pageToken;
    let url = "https://www.googleapis.com/drive/v3/files";
    url += "?" + params_to_query(params);
    const payload = { headers, timeout: TIMEOUT_BASE };
    let retry = 0;
    let data;
    while (!data && (retry < RETRY_LIMIT || RETRY_LIMIT <= 0)) {
      try {
        data = (await axins.get(url, payload)).data;
      } catch (err) {
        handle_error(err);
        retry++;
        payload.timeout = Math.min(payload.timeout * 2, TIMEOUT_MAX);
      }
    }
    if (!data) {
      console.error("读取目录未完成(部分读取), 参数:", params);
      files.not_finished = true;
      return files;
    }
    files = files.concat(data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

async function gen_headers(use_sa) {
  // use_sa = use_sa && SA_TOKENS.length
  const access_token = use_sa
    ? (await get_sa_token()).access_token
    : await get_access_token();
  return { authorization: "Bearer " + access_token };
}

function params_to_query(data) {
  const ret = [];
  for (let d in data) {
    ret.push(encodeURIComponent(d) + "=" + encodeURIComponent(data[d]));
  }
  return ret.join("&");
}

async function get_access_token() {
  const {
    expires,
    access_token,
    client_id,
    client_secret,
    refresh_token
  } = AUTH;
  if (expires > Date.now()) return access_token;

  const url = "https://www.googleapis.com/oauth2/v4/token";
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const config = { headers };
  const params = {
    client_id,
    client_secret,
    refresh_token,
    grant_type: "refresh_token"
  };
  const { data } = await axins.post(url, params_to_query(params), config);
  // console.log('Got new token:', data)
  AUTH.access_token = data.access_token;
  AUTH.expires = Date.now() + 1000 * data.expires_in;
  return data.access_token;
}

async function get_sa_token() {
  if (!SA_TOKENS.length) {
    SA_TOKENS = get_sa_batch();
  }
  while (SA_TOKENS.length) {
    const tk = get_random_element(SA_TOKENS);
    try {
      return await real_get_sa_token(tk);
    } catch (e) {
      console.log(e);
      SA_TOKENS = SA_TOKENS.filter((v) => v.gtoken !== tk.gtoken);
      if (!SA_TOKENS.length) {
        SA_TOKENS = get_sa_batch();
      }
    }
  }
  throw new Error("没有可用的SA帐号");
}

async function real_get_sa_token(el) {
  const { value, expires, gtoken } = el;
  // 把gtoken传递出去的原因是当某账号流量用尽时可以依此过滤
  if (Date.now() < expires) {
    return { access_token: value, gtoken };
  }
  const { access_token, expires_in } = await gtoken.getToken({
    forceRefresh: true
  });
  el.value = access_token;
  el.expires = Date.now() + 1000 * (expires_in - 60 * 5); // 提前5分钟判定为过期
  return { access_token, gtoken };
}

function get_random_element(arr) {
  return arr[~~(arr.length * Math.random())];
}

function validate_fid(fid) {
  if (!fid) {
    return false;
  }
  fid = String(fid);
  const whitelist = ["root", "appDataFolder", "photos"];
  if (whitelist.includes(fid)) return true;
  if (fid.length < 10 || fid.length > 100) return false;
  const reg = /^[a-zA-Z0-9_-]+$/;
  return fid.match(reg);
}

async function create_txt(name, parent, use_sa, content) {
  if (!content) {
    return;
  }
  const headers = await gen_headers(use_sa);
  let noteFile;
  retry = 0;
  while (retry++ < 3) {
    try {
      noteFile = (await axins.post(
        `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`,
        { name: `${name}.txt`, parents: [parent] },
        { headers }
      )).data;
      break;
    } catch (e) {
      console.log(`Error: add ${name}.txt`);
      axiosErrorLogger(e);
    }
  }
  if (noteFile) {
    let data = !Buffer.isBuffer(content) ? Buffer.from(content) : content;
    retry = 0;
    while (retry++ < 3) {
      try {
        await axins.patch(
          `https://www.googleapis.com/upload/drive/v3/files/${
            noteFile.id
          }?uploadType=media&supportsAllDrives=true`,
          data,
          {
            headers: Object.assign({}, headers, {
              ["Content-Type"]: "text/plain",
              ["Content-Length"]: data.byteLength
            })
          }
        );
        break;
      } catch (e) {
        console.log(`Error: put ${name}.txt`);
        axiosErrorLogger(e);
      }
    }
  }
}

async function create_folder(name, parent, use_sa, limit, note) {
  let url = `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`;
  const post_data = {
    name,
    mimeType: FOLDER_TYPE,
    parents: [parent]
  };
  let retry = 0;
  let err_message;
  while (retry < RETRY_LIMIT || RETRY_LIMIT <= 0) {
    try {
      const headers = await gen_headers(use_sa);
      let { data } = await axins.post(url, post_data, { headers });
      await create_txt(name, parent, use_sa, note);
      return data;
    } catch (err) {
      err_message = err.message;
      retry++;
      handle_error(err);
      const data = err && err.response && err.response.data;
      const message = data && data.error && data.error.message;
      if (message && message.toLowerCase().includes("file limit")) {
        if (limit) {
          limit.clearQueue();
        }
        throw new Error(FILE_EXCEED_MSG);
      }
      console.log(`重试${retry}次创建目录 ${name}`);
    }
  }
  throw new Error(`创建目录 ${name} 出错：${err_message}`);
}

async function get_info_by_id(fid, use_sa) {
  let url = `https://www.googleapis.com/drive/v3/files/${fid}`;
  let params = {
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: "allDrives",
    fields: "id,name,owners,mimeType"
  };
  url += "?" + params_to_query(params);
  const headers = await gen_headers(use_sa);
  const { data } = await axins.get(url, { headers });
  return data;
}

async function user_choose() {
  const answer = await prompts({
    type: "select",
    name: "value",
    message: "检测到上次的复制记录，是否继续？",
    choices: [
      {
        title: "Continue",
        description: "从上次中断的地方继续",
        value: "continue"
      },
      {
        title: "Restart",
        description: "无视已存在的记录，重新复制",
        value: "restart"
      },
      { title: "Exit", description: "直接退出", value: "exit" }
    ],
    initial: 0
  });
  return answer.value;
}

async function copy({
  source,
  target,
  name,
  min_size,
  update,
  not_teamdrive,
  service_account,
  is_server
}) {
  target = target || DEFAULT_TARGET;
  if (!target) {
    throw new Error("目标位置不能为空");
  }

  const record = db
    .prepare("select id, status from task where source=? and target=?")
    .get(source, target);
  if (record && record.status === "copying") {
    return console.log("已有相同源和目的地的任务正在运行，强制退出");
  }

  try {
    return await real_copy({
      source,
      target,
      name,
      min_size,
      update,
      not_teamdrive,
      service_account,
      is_server
    });
  } catch (err) {
    console.error("复制文件夹出错", err);
    const record = db
      .prepare("select id, status from task where source=? and target=?")
      .get(source, target);
    if (record)
      db.prepare("update task set status=? where id=?").run("error", record.id);
  }
}

// 待解决：如果用户手动ctrl+c中断进程，那么已经发出的请求，就算完成了也不会记录到本地数据库中，所以可能产生重复文件（夹）
async function real_copy({
  source,
  target,
  name,
  min_size,
  update,
  dncnr,
  not_teamdrive,
  service_account,
  is_server,
  note = ""
}) {
  const source_info = await get_info_by_id(source, service_account);

  if (source_info.mimeType !== FOLDER_TYPE) {
    let file = await copy_file(source_info.id, target, service_account);
    await create_txt(source_info.name, target, service_account, note);
    return { file };
  }

  async function get_new_root() {
    if (dncnr) return { id: target };
    if (name) {
      return create_folder(name, target, service_account, note);
    } else {
      return create_folder(source_info.name, target, service_account, note);
    }
  }

  const record = db
    .prepare("select * from task where source=? and target=?")
    .get(source, target);
  if (record) {
    const copied = db
      .prepare("select fileid from copied where taskid=?")
      .all(record.id)
      .map((v) => v.fileid);
    const choice = is_server ? "continue" : await user_choose();
    if (choice === "exit") {
      console.log("退出程序");
      return {};
    } else if (choice === "continue") {
      let { mapping } = record;
      const old_mapping = {};
      const copied_ids = {};
      copied.forEach((id) => (copied_ids[id] = true));
      mapping = mapping
        .trim()
        .split("\n")
        .map((line) => line.split(" "));
      const root = mapping[0][1];
      mapping.forEach((arr) => (old_mapping[arr[0]] = arr[1]));
      db.prepare("update task set status=? where id=?").run(
        "copying",
        record.id
      );
      const arr = await walk_and_save({
        fid: source,
        update,
        not_teamdrive,
        service_account
      });
      let files = arr
        .filter((v) => v.mimeType !== FOLDER_TYPE)
        .filter((v) => !copied_ids[v.id]);
      if (min_size) {
        files = files.filter((v) => v.size >= min_size);
      }
      const folders = arr.filter((v) => v.mimeType === FOLDER_TYPE);
      console.log("待复制的目录数：", folders.length);
      console.log("待复制的文件数：", files.length);
      const all_mapping = await create_folders({
        old_mapping,
        source,
        folders,
        service_account,
        root,
        task_id: record.id
      });
      await copy_files({
        files,
        service_account,
        root,
        mapping: all_mapping,
        task_id: record.id
      });
      db.prepare("update task set status=?, ftime=? where id=?").run(
        "finished",
        Date.now(),
        record.id
      );
      return { id: root, task_id: record.id };
    } else if (choice === "restart") {
      const new_root = await get_new_root();
      const root_mapping = source + " " + new_root.id + "\n";
      db.prepare("update task set status=?, mapping=? where id=?").run(
        "copying",
        root_mapping,
        record.id
      );
      db.prepare("delete from copied where taskid=?").run(record.id);
      const arr = await walk_and_save({
        fid: source,
        update,
        not_teamdrive,
        service_account
      });

      let files = arr.filter((v) => v.mimeType !== FOLDER_TYPE);
      if (min_size) files = files.filter((v) => v.size >= min_size);
      const folders = arr.filter((v) => v.mimeType === FOLDER_TYPE);
      console.log("待复制的目录数：", folders.length);
      console.log("待复制的文件数：", files.length);
      const mapping = await create_folders({
        source,
        folders,
        service_account,
        root: new_root.id,
        task_id: record.id
      });
      await copy_files({
        files,
        mapping,
        service_account,
        root: new_root.id,
        task_id: record.id
      });
      db.prepare("update task set status=?, ftime=? where id=?").run(
        "finished",
        Date.now(),
        record.id
      );
      return { id: new_root.id, task_id: record.id };
    } else {
      // ctrl+c 退出
      console.log("退出程序");
      return {};
    }
  } else {
    const new_root = await get_new_root();
    const root_mapping = source + " " + new_root.id + "\n";
    const { lastInsertRowid } = db
      .prepare(
        "insert into task (source, target, status, mapping, name, note, ctime) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        source,
        target,
        "copying",
        root_mapping,
        new_root.name,
        note,
        Date.now()
      );
    const arr = await walk_and_save({
      fid: source,
      update,
      not_teamdrive,
      service_account
    });
    let files = arr.filter((v) => v.mimeType !== FOLDER_TYPE);
    if (min_size) {
      files = files.filter((v) => v.size >= min_size);
    }
    const folders = arr.filter((v) => v.mimeType === FOLDER_TYPE);
    console.log("待复制的目录数：", folders.length);
    console.log("待复制的文件数：", files.length);
    const mapping = await create_folders({
      source,
      folders,
      service_account,
      root: new_root.id,
      task_id: lastInsertRowid
    });
    await copy_files({
      files,
      mapping,
      service_account,
      root: new_root.id,
      task_id: lastInsertRowid
    });
    db.prepare("update task set status=?, ftime=? where id=?").run(
      "finished",
      Date.now(),
      lastInsertRowid
    );
    return { id: new_root.id, task_id: lastInsertRowid };
  }
}

async function copy_files({ files, mapping, service_account, root, task_id }) {
  if (!files.length) return;
  console.log("\n开始复制文件，总数：", files.length);

  const loop = setInterval(() => {
    print_progress(
      `${dayjs().format("HH:mm:ss")} | 已复制文件数 ${count} | 排队中文件数 ${
        files.length
      }`
    );
  }, 1000);

  let count = 0;
  let concurrency = 0;
  let err;
  do {
    if (err) {
      clearInterval(loop);
      throw err;
    }
    if (concurrency > PARALLEL_LIMIT) {
      await sleep(100);
      continue;
    }
    const file = files.shift();
    if (!file) {
      await sleep(1000);
      continue;
    }
    concurrency++;
    const { id, parent } = file;
    const target = mapping[parent] || root;
    copy_file(id, target, service_account, null, task_id)
      .then((new_file) => {
        if (new_file) {
          count++;
          db.prepare("INSERT INTO copied (taskid, fileid) VALUES (?, ?)").run(
            task_id,
            id
          );
        }
      })
      .catch((e) => {
        err = e;
      })
      .finally(() => {
        concurrency--;
      });
  } while (concurrency);
  clearInterval(loop);
}

async function copy_file(id, parent, use_sa) {
  let url = `https://www.googleapis.com/drive/v3/files/${id}/copy?supportsAllDrives=true`;
  const config = {};
  let retry = 0;
  while (retry < RETRY_LIMIT || RETRY_LIMIT <= 0) {
    let gtoken;
    if (use_sa) {
      // 如果有sa文件则优先使用
      const temp = await get_sa_token();
      gtoken = temp.gtoken;
      config.headers = { authorization: "Bearer " + temp.access_token };
    } else {
      config.headers = await gen_headers();
    }
    try {
      const { data } = await axins.post(url, { parents: [parent] }, config);
      return data;
    } catch (err) {
      retry++;
      handle_error(err);
      const data = err && err.response && err.response.data;
      const message = data && data.error && data.error.message;
      if (message && message.toLowerCase().includes("rate limit")) {
        SA_TOKENS = SA_TOKENS.filter((v) => v.gtoken !== gtoken);
        if (!SA_TOKENS.length) {
          SA_TOKENS = get_sa_batch();
        }
        console.log(`此sa帐号触发限额，剩余可用sa帐号：${SA_TOKENS.length}`);
      }
    }
  }
  if (!SA_TOKENS.length) {
    throw new Error("所有SA帐号流量已用完");
  } else {
    console.warn(`复制文件 ${id} 失败`);
  }
}

async function create_folders({
  source,
  old_mapping,
  folders,
  root,
  task_id,
  service_account
}) {
  if (!Array.isArray(folders)) {
    throw new Error("folders must be Array:" + folders);
  }
  const mapping = old_mapping || {};
  mapping[source] = root;
  if (!folders.length) return mapping;

  const missed_folders = folders.filter((v) => !mapping[v.id]);
  console.log("开始复制文件夹，总数：", missed_folders.length);
  const limit = pLimit(PARALLEL_LIMIT);
  let count = 0;
  let same_levels = folders.filter((v) => v.parent === folders[0].parent);

  const loop = setInterval(() => {
    const now = dayjs().format("HH:mm:ss");
    const message = `${now} | 已创建目录 ${count} | 网络请求 进行中${
      limit.activeCount
    }/排队中${limit.pendingCount}`;
    print_progress(message);
  }, 1000);

  while (same_levels.length) {
    const same_levels_missed = same_levels.filter((v) => !mapping[v.id]);
    await Promise.all(
      same_levels_missed.map(async (v) => {
        try {
          const { name, id, parent } = v;
          const target = mapping[parent] || root;
          const new_folder = await limit(() =>
            create_folder(name, target, service_account, limit)
          );
          count++;
          mapping[id] = new_folder.id;
          const mapping_record = id + " " + new_folder.id + "\n";
          db.prepare("update task set mapping = mapping || ? where id=?").run(
            mapping_record,
            task_id
          );
        } catch (e) {
          if (e.message === FILE_EXCEED_MSG) {
            clearInterval(loop);
            throw new Error(FILE_EXCEED_MSG);
          }
          console.error("创建目录出错:", e.message);
        }
      })
    );
    // folders = folders.filter(v => !mapping[v.id])
    same_levels = [].concat(
      ...same_levels.map((v) => folders.filter((vv) => vv.parent === v.id))
    );
  }

  clearInterval(loop);
  return mapping;
}

function find_dupe(arr) {
  const files = arr.filter((v) => v.mimeType !== FOLDER_TYPE);
  const folders = arr.filter((v) => v.mimeType === FOLDER_TYPE);
  const exists = {};
  const dupe_files = [];
  const dupe_folder_keys = {};
  for (const folder of folders) {
    const { parent, name } = folder;
    const key = parent + "|" + name;
    if (exists[key]) {
      dupe_folder_keys[key] = true;
    } else {
      exists[key] = true;
    }
  }
  const dupe_empty_folders = folders
    .filter((folder) => {
      const { parent, name } = folder;
      const key = parent + "|" + name;
      return dupe_folder_keys[key];
    })
    .filter((folder) => {
      const has_child = arr.some((v) => v.parent === folder.id);
      return !has_child;
    });
  for (const file of files) {
    const { md5Checksum, parent, name } = file;
    // 根据文件位置和md5值来判断是否重复
    const key = parent + "|" + md5Checksum; // + '|' + name
    if (exists[key]) {
      dupe_files.push(file);
    } else {
      exists[key] = true;
    }
  }
  return dupe_files.concat(dupe_empty_folders);
}

async function confirm_dedupe({ file_number, folder_number }) {
  const answer = await prompts({
    type: "select",
    name: "value",
    message: `检测到重复文件${file_number}个，重复目录${folder_number}个，是否删除？`,
    choices: [
      { title: "Yes", description: "确认删除", value: "yes" },
      { title: "No", description: "先不删除", value: "no" }
    ],
    initial: 0
  });
  return answer.value;
}

// 将文件或文件夹移入回收站，需要 sa 为 content manager 权限及以上
async function trash_file({ fid, service_account }) {
  const url = `https://www.googleapis.com/drive/v3/files/${fid}?supportsAllDrives=true`;
  const headers = await gen_headers(service_account);
  return axins.patch(url, { trashed: true }, { headers });
}

// 直接删除文件或文件夹，不会进入回收站，需要 sa 为 manager 权限
async function rm_file({ fid, service_account }) {
  const headers = await gen_headers(service_account);
  let retry = 0;
  const url = `https://www.googleapis.com/drive/v3/files/${fid}?supportsAllDrives=true`;
  while (retry < RETRY_LIMIT || RETRY_LIMIT <= 0) {
    try {
      return await axins.delete(url, { headers });
    } catch (err) {
      retry++;
      handle_error(err);
      console.log("删除重试中，重试次数", retry);
    }
  }
}

async function dedupe({ fid, update, service_account }) {
  let arr;
  if (!update) {
    const info = get_all_by_fid(fid);
    if (info) {
      console.log("找到本地缓存数据，缓存时间：", dayjs(info.mtime).format());
      arr = info;
    }
  }
  arr = arr || (await walk_and_save({ fid, update, service_account }));
  const dupes = find_dupe(arr);
  const folder_number = dupes.filter((v) => v.mimeType === FOLDER_TYPE).length;
  const file_number = dupes.length - folder_number;
  const choice = await confirm_dedupe({ file_number, folder_number });
  if (choice === "no") {
    return console.log("退出程序");
  } else if (!choice) {
    return; // ctrl+c
  }
  const limit = pLimit(PARALLEL_LIMIT);
  let folder_count = 0;
  let file_count = 0;
  await Promise.all(
    dupes.map(async (v) => {
      try {
        await limit(() =>
          (USE_TRASH ? trash_file : rm_file)({ fid: v.id, service_account })
        );
        if (v.mimeType === FOLDER_TYPE) {
          console.log("成功删除文件夹", v.name);
          folder_count++;
        } else {
          console.log("成功删除文件", v.name);
          file_count++;
        }
      } catch (e) {
        console.log("删除失败", e.message);
      }
    })
  );
  return { file_count, folder_count };
}

function handle_error(err) {
  const data = err && err.response && err.response.data;
  if (data) {
    console.error(JSON.stringify(data));
  } else {
    if (!err.message.includes("timeout")) console.error(err.message);
  }
}

function print_progress(msg) {
  if (process.stdout.cursorTo) {
    process.stdout.cursorTo(0);
    process.stdout.write(msg);
  } else {
    console.log(msg);
  }
}

module.exports = {
  ls_folder,
  count,
  validate_fid,
  copy,
  dedupe,
  copy_file,
  gen_count_body,
  real_copy
};

function axiosErrorLogger(error) {
  if (error.response) {
    console.log("axiosErrorResponse");
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    console.log(error.response.data);
    console.log(error.response.status);
    console.log(error.response.headers);
  } else if (error.request) {
    console.log("axiosErrorRequest");
    // The request was made but no response was received
    // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
    // http.ClientRequest in node.js
    console.log(error.request);
  } else {
    // Something happened in setting up the request that triggered an Error
    console.log("axiosError", error.message);
  }
  console.log(error.config);
}
