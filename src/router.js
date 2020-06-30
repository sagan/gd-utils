const Router = require("@koa/router");

const { db } = require("../db");
const { validate_fid, gen_count_body } = require("./gd");
const {
  send_count,
  send_help,
  send_choice,
  send_task_info,
  sm,
  extract_fid,
  reply_cb_query,
  tg_copy,
  tg_run,
  tg_clear,
  send_all_tasks
} = require("./tg");

const { AUTH } = require("../config.loader");
const { tg_whitelist } = AUTH;

const counting = {};
const router = new Router();

router.get("/api/gdurl/count", async (ctx) => {
  const { query, headers } = ctx.request;
  let { fid, type, update } = query;
  if (!validate_fid(fid)) throw new Error("无效的分享ID");
  let ua = headers["user-agent"] || "";
  ua = ua.toLowerCase();
  type = (type || "").toLowerCase();
  if (!type) {
    if (ua.includes("curl")) {
      type = "curl";
    } else if (ua.includes("mozilla")) {
      type = "html";
    } else {
      type = "json";
    }
  }
  if (type === "html") {
    ctx.set("Content-Type", "text/html; charset=utf-8");
  } else if (["json", "all"].includes(type)) {
    ctx.set("Content-Type", "application/json; charset=UTF-8");
  }
  ctx.body = await gen_count_body({ fid, type, update, service_account: true });
});

router.post("/api/gdurl/tgbot", async (ctx) => {
  const { body } = ctx.request;
  // console.log("tg message:", ctx.ip, body);
  ctx.body = ""; // 早点释放连接
  const message = body.message || body.edited_message;
  const { callback_query } = body;
  let chat_id, text, username, callback_query_id, note;

  if (callback_query) {
    callback_query_id = callback_query.id;
    text = callback_query.data;
    username = callback_query.from.username;
    chat_id = callback_query.from.id;
    note = callback_query.message ? callback_query.message.text : "";
  } else if (message) {
    text = message.text && message.text.trim();
    username = message.from && message.from.username;
    chat_id = message.chat.id;
  }
  if (!text || !username || !tg_whitelist.includes(username)) {
    return console.warn(`Unauthorized user ${username} or empty request`);
  }

  if (callback_query_id || text.startsWith("/")) {
    let params = text.split(/\s+/);
    let command = params.shift();
    if (command[0] == "/") {
      command = command.slice(1);
    }
    if (command == "help") {
      send_help(chat_id);
    } else if (command == "count") {
      const [fid] = params;
      if (!fid) {
        sm({ chat_id, text: `命令参数不正确` });
      } else if (counting[fid]) {
        sm({ chat_id, text: `正在统计 ${fid}，请稍等片刻` });
      } else {
        try {
          counting[fid] = true;
          await send_count({ fid, chat_id });
        } catch (err) {
          console.error(err);
          sm({ chat_id, text: fid + " 统计失败：" + err.message });
        } finally {
          delete counting[fid];
        }
      }
    } else if (command == "copy") {
      const [fid, target] = params;
      if (!fid) {
        sm({ chat_id, text: `命令参数不正确` });
      } else if (target && !validate_fid(target)) {
        sm({ chat_id, text: `目标ID ${target} 格式不正确` });
      } else {
        tg_copy({ fid, target, chat_id, note }).then((task_id) => {
          task_id &&
            sm({
              chat_id,
              text: `开始复制 ${fid}，任务ID: ${task_id} 可输入 /task ${task_id} 查询进度`,
              reply_markup: {
                inline_keyboard: [
                  [{ text: "查询进度", callback_data: `task ${task_id}` }],
                  [{ text: "所有任务", callback_data: `task` }]
                ]
              }
            });
        });
      }
    } else if (command == "task") {
      const [task_id] = params;
      if (!task_id || task_id === "all") {
        send_all_tasks(chat_id);
      } else {
        task_id = parseInt(task_id);
        if (!task_id) {
          const running_tasks = db
            .prepare("select id from task where status = ?")
            .all("copying");
          if (!running_tasks.length) {
            sm({ chat_id, text: "当前暂无运行中的任务" });
          } else {
            running_tasks.forEach((v) =>
              send_task_info({ chat_id, task_id: v.id }).catch(console.error)
            );
          }
        } else {
          send_task_info({ task_id, chat_id }).catch(console.error);
        }
      }
    } else if (command == "clear") {
      tg_clear({ chat_id, type: params[0] });
    } else if (command == "run") {
      tg_run({ chat_id, task_id: params[0] });
    } else {
      sm({ chat_id, text: `未找到 ${command} 命令` });
    }
  } else {
    const fid = extract_fid(text);
    if (!validate_fid(fid)) {
      sm({ chat_id, text: "未识别出分享ID" });
    } else {
      send_choice({ fid, chat_id, note: text }).catch(console.error);
    }
  }
  if (callback_query_id) {
    reply_cb_query({ id: callback_query_id, data: text }).catch(console.error);
  }
});

module.exports = router;
