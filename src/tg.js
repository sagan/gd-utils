const Table = require("cli-table3");
const dayjs = require("dayjs");
const axios = require("@viegg/axios");
const HttpsProxyAgent = require("https-proxy-agent");

const { db } = require("../db");
const { gen_count_body, validate_fid, real_copy } = require("./gd");
const { AUTH, DEFAULT_TARGET } = require("../config.loader");
const { tg_token } = AUTH;

if (!tg_token) throw new Error("请先在auth.js里设置tg_token");
const { https_proxy } = process.env;
const axins = axios.create(
  https_proxy ? { httpsAgent: new HttpsProxyAgent(https_proxy) } : {}
);

module.exports = {
  send_count,
  send_help,
  sm,
  extract_fid,
  reply_cb_query,
  send_choice,
  send_task_info,
  send_all_tasks,
  tg_run,
  tg_clear,
  tg_copy
};

function send_help(chat_id) {
  const text = `<pre>[使用帮助]
命令 ｜ 说明

/help | 返回本条使用说明

/run taskID | 重新开始运行(已中断的)任务

/clear [type] | 清除已完成任务信息；如果 type 为 destroy, 会清空所有数据

/count shareID | 返回sourceID的文件统计信息, sourceID可以是 google drive分享网址本身，也可以是分享ID

/copy sourceID [targetID] | 将sourceID的文件复制到targetID里（会新建一个文件夹），若不提供 targetID，则会复制到默认位置（在config.js里设置）。返回拷贝任务的taskID

/task [taskID] | 返回对应任务的进度信息。不提供 taskID 或 taskID 为 all 则返回所有任务列表；taskID 为 0 则返回所有正在运行的任务进度

{其它任意文本} | 识别文本里出现的(第1个) Google Drive 分享链接或 ID 并提供选项以转存

</pre>`;
  return sm({ chat_id, text, parse_mode: "HTML" });
}

function send_choice({ fid, chat_id, note }) {
  return sm({
    chat_id,
    text: `分享ID: ${fid}
日期: ${dayjs().format()}
链接: https://drive.google.com/drive/folders/${fid}
说明:\n\n${(note || "").trim().slice(0, 2000)}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "文件统计", callback_data: `count ${fid}` },
          { text: "开始复制", callback_data: `copy ${fid}` }
        ]
      ]
    }
  });
}

async function send_all_tasks(chat_id) {
  let limit = 20;
  let records = db
    .prepare(
      `select id, status, name, ctime from task order by id desc limit ${limit}`
    )
    .all()
    .sort((a, b) => a.id - b.id);
  if (!records.length) return sm({ chat_id, text: "数据库中没有任务记录" });
  const inline_keyboard = [
    records
      .filter((a) => a.status == "copying" || a.status == "interrupt")
      .slice(-5)
      .map(({ id }) =>
        a.status == "copying"
          ? { text: `任务${id}进度`, callback_data: `task ${id}` }
          : { text: `恢复${id}任务`, callback_data: `run ${id}` }
      )
      .concat({ text: "刷新", callback_data: `task` })
  ];
  const tb = new Table({ style: { head: [], border: [] } });
  const headers = ["ID", "status", "name", "ctime"];
  records = records.map((v) => {
    const { id, status, name, ctime } = v;
    return [id, status, name, dayjs(ctime).format()];
  });
  tb.push(headers, ...records);
  const text = tb.toString().replace(/─/g, "—");
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`;
  return axins
    .post(url, {
      chat_id,
      parse_mode: "HTML",
      text: `最近${limit}条拷贝任务：\n<pre>${text}</pre>`,
      reply_markup: {
        inline_keyboard
      }
    })
    .catch(async (err) => {
      const description =
        err.response && err.response.data && err.response.data.description;
      if (description && description.includes("message is too long")) {
        const text = [headers]
          .concat(records)
          .map((v) => v.join("\t"))
          .join("\n");
        return sm({
          chat_id,
          parse_mode: "HTML",
          text: `最近${limit}条拷贝任务：\n<pre>${text}</pre>`,
          reply_markup: {
            inline_keyboard
          }
        });
      }
      console.error(err);
    });
}

async function send_task_info({ task_id, chat_id }) {
  const record = db.prepare("select * from task where id=?").get(task_id);
  if (!record) return sm({ chat_id, text: "数据库不存在此任务ID：" + task_id });

  const gen_link = (fid) =>
    `<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>`;
  const {
    source,
    target,
    status,
    copied,
    mapping,
    name,
    note,
    ctime,
    ftime
  } = record;
  const { summary } =
    db.prepare("select summary from gd where fid = ?").get(source) || {};
  const { file_count, folder_count, total_size } = summary
    ? JSON.parse(summary)
    : {};
  const copied_files = copied ? copied.trim().split("\n").length : 0;
  const copied_folders = mapping ? mapping.trim().split("\n").length - 1 : 0;
  let text = `任务编号: ${task_id}
源ID: ${gen_link(source)}
目的ID: ${gen_link(target)}
文件夹名称: ${name}
任务状态: ${status}
创建时间: ${dayjs(ctime).format()}
完成时间: ${ftime ? dayjs(ftime).format() : "未完成"}
目录进度: ${copied_folders} / ${
    folder_count === undefined ? "未知数量" : folder_count
  }
文件进度: ${copied_files} / ${
    file_count === undefined ? "未知数量" : file_count
  }
总大小: ${total_size || "未知大小"}
文件备注:

${note}
`;

  let inline_keyboard = [[]];
  inline_keyboard[0].push({
    text: "统计源",
    callback_data: `count ${source}`
  });
  if (status == "finished") {
    inline_keyboard[0].push({
      text: "统计已复制",
      callback_data: `count ${target}`
    });
  } else {
    inline_keyboard[0].push({
      text: "重新查询进度",
      callback_data: `task ${task_id}`
    });
  }
  inline_keyboard[0].push({ text: "所有任务", callback_data: `task` });
  return sm({
    chat_id,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard
    }
  });
}

async function tg_clear({ chat_id, type }) {
  if (!type) {
    db.prepare("delete from task where status = ?").run("finished");
    sm({
      chat_id,
      text: `已清空所有已完成任务`,
      reply_markup: {
        inline_keyboard: [[{ text: "所有任务", callback_data: `task` }]]
      }
    });
  } else if (type == "destroy") {
    db.prepare("delete from task").run();
    db.prepare("delete from gd").run();
    sm({
      chat_id,
      text: `已清空所有数据`
    });
  } else {
    sm({
      chat_id,
      text: `未识别的清空命令类型 ${type}`
    });
  }
}

async function tg_run({ task_id, chat_id }) {
  let record = db
    .prepare("select id, status, source, target, note from task where id = ?")
    .get(task_id);
  if (!record) {
    return sm({
      chat_id,
      text: `未找到任务 ${task_id}`
    });
  }
  if (record.status != "interrupt") {
    return sm({
      chat_id,
      text: `任务 ${task_id} 当前状态 ${record.status} 不支持此(run)操作`
    });
  }
  return tg_copy({
    fid: record.source,
    target: record.target,
    chat_id,
    note: record.note
  });
}

async function tg_copy({ fid, target, chat_id, note }) {
  // return task_id
  target = target || DEFAULT_TARGET;
  if (!target) {
    sm({
      chat_id,
      text:
        "请输入目的地ID或先在config.js里设置默认复制目的地ID(DEFAULT_TARGET)"
    });
    return;
  }

  let record = db
    .prepare("select id, status from task where source=? and target=?")
    .get(fid, target);
  if (record) {
    if (record.status === "copying") {
      sm({
        chat_id,
        text:
          "已有相同源ID和目的ID的任务正在进行，查询进度可输入 /task " +
          record.id
      });
      return;
    } else if (record.status === "finished") {
      sm({
        chat_id,
        text: "有相同源ID和目的ID的任务已复制完成，如需重新复制请更换目的地"
      });
      return;
    }
  }

  real_copy({
    source: fid,
    target,
    note,
    not_teamdrive: true,
    service_account: true,
    is_server: true
  })
    .then((folder) => {
      if (!record) record = {}; // 防止无限循环
      if (!folder) return;
      const link = "https://drive.google.com/drive/folders/" + folder.id;
      sm({
        chat_id,
        text: `${fid} 复制完成，新文件夹链接：${link}`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "统计源", callback_data: `count ${fid}` },
              { text: "统计复制", callback_data: `count ${target}` },
              { text: "所有任务", callback_data: `task` }
            ]
          ]
        }
      });
    })
    .catch((err) => {
      if (!record) record = {};
      console.error("复制失败", fid, "-->", target);
      console.error(err);
      sm({ chat_id, text: "复制失败，失败消息：" + err.message });
    });

  while (!record) {
    record = db
      .prepare("select id from task where source=? and target=?")
      .get(fid, target);
    await sleep(1000);
  }
  return record.id;
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

function reply_cb_query({ id, data }) {
  const url = `https://api.telegram.org/bot${tg_token}/answerCallbackQuery`;
  return axins.post(url, {
    callback_query_id: id,
    text: "开始执行 " + data
  });
}

async function send_count({ fid, chat_id }) {
  const table = await gen_count_body({
    fid,
    type: "tg",
    service_account: true
  });
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`;
  const gd_link = `https://drive.google.com/drive/folders/${fid}`;
  return axins
    .post(url, {
      chat_id,
      parse_mode: "HTML",
      // todo 输出文件名
      text: `<pre>${gd_link}
${table}</pre>`
    })
    .catch(async (err) => {
      const description =
        err.response && err.response.data && err.response.data.description;
      if (description && description.includes("message is too long")) {
        const smy = await gen_count_body({
          fid,
          type: "json",
          service_account: true
        });
        const { file_count, folder_count, total_size } = JSON.parse(smy);
        return sm({
          chat_id,
          parse_mode: "HTML",
          text: `文件统计：<a href="https://drive.google.com/drive/folders/${fid}">${fid}</a>\n<pre>
表格太长超出telegram消息限制，只显示概要：
文件总数：${file_count}
目录总数：${folder_count}
文件+目录总数：${file_count + folder_count}
合计大小：${total_size}
</pre>`
        });
      }
      throw err;
    });
}

function sm(data) {
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`;
  return axins.post(url, data).catch((err) => {
    console.error("fail to post", url, data);
    console.error(err);
  });
}

function extract_fid(text) {
  try {
    let match;
    match = text.match(/(https:\/\/)?(drive.google.com\/[-\/_=?&%a-zA-Z0-9]*)/);
    if (match) {
      let url = (match[1] || "https://") + match[2];
      const u = new URL(url);
      if (u.pathname.includes("/folders/")) {
        match = u.pathname.match(/\/folders\/([-_a-zA-Z0-9]{10,100})/);
        return match && match[1];
      }
      return u.searchParams.get("id");
    }
    match = text.match(/\b[-_a-zA-Z0-9]{10,100}\b/);
    if (match) {
      return match[0];
    }
  } catch (e) {}
}
