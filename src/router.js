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
  send_all_tasks
} = require("./tg");

const { AUTH } = require("../config");
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
  console.log("ctx.ip", ctx.ip); // 可以只允许tg服务器的ip
  console.log("tg message:", body);
  ctx.body = ""; // 早点释放连接
  const message = body.message || body.edited_message;

  const { callback_query } = body;
  if (callback_query) {
    const { id, data } = callback_query;
    const chat_id = callback_query.from.id;
    const note = callback_query.message ? callback_query.message.text : "";
    const [action, fid] = data.split(" ");
    if (action === "count") {
      if (counting[fid])
        return sm({ chat_id, text: fid + " 正在统计，请稍等片刻" });
      counting[fid] = true;
      send_count({ fid, chat_id })
        .catch((err) => {
          console.error(err);
          sm({ chat_id, text: fid + " 统计失败：" + err.message });
        })
        .finally(() => {
          delete counting[fid];
        });
    } else if (action === "copy") {
      tg_copy({ fid, chat_id, note }).then((task_id) => {
        task_id &&
          sm({
            chat_id,
            text: `开始复制，任务ID: ${task_id} 可输入 /task ${task_id} 查询进度`
          });
      });
    } else if (action === "task") {
      send_task_info({ task_id: fid, chat_id }).catch(console.error);
    }
    return reply_cb_query({ id, data }).catch(console.error);
  }

  const chat_id = message && message.chat && message.chat.id;
  const text = message && message.text && message.text.trim();
  const username = message && message.from && message.from.username;
  if (!chat_id || !text || !tg_whitelist.includes(username))
    return console.warn("异常请求");

  const fid = extract_fid(text);
  const no_fid_commands = ["/task", "/help"];
  if (
    !no_fid_commands.some((cmd) => text.startsWith(cmd)) &&
    !validate_fid(fid)
  ) {
    return sm({ chat_id, text: "未识别出分享ID" });
  }
  if (text.startsWith("/")) {
    if (text.startsWith("/help")) {
      return send_help(chat_id);
    } else if (text.startsWith("/count")) {
      if (counting[fid])
        return sm({ chat_id, text: fid + " 正在统计，请稍等片刻" });
      try {
        counting[fid] = true;
        await send_count({ fid, chat_id });
      } catch (err) {
        console.error(err);
        sm({ chat_id, text: fid + " 统计失败：" + err.message });
      } finally {
        delete counting[fid];
      }
    } else if (text.startsWith("/copy")) {
      const target = text
        .replace("/copy", "")
        .trim()
        .split(" ")
        .map((v) => v.trim())[1];
      if (target && !validate_fid(target)) {
        return sm({ chat_id, text: `目标ID ${target} 格式不正确` });
      }
      tg_copy({ fid, target, chat_id }).then((task_id) => {
        task_id &&
          sm({
            chat_id,
            text: `开始复制 ${fid}，任务ID: ${task_id} 可输入 /task ${task_id} 查询进度`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "查询进度", callback_data: `task ${task_id}` }]
              ]
            }
          });
      });
    } else if (text.startsWith("/task")) {
      let task_id = text.replace("/task", "").trim();
      if (task_id === "all") {
        return send_all_tasks(chat_id);
      }
      task_id = parseInt(task_id);
      if (!task_id) {
        const running_tasks = db
          .prepare("select id from task where status=?")
          .all("copying");
        if (!running_tasks.length)
          return sm({ chat_id, text: "当前暂无运行中的任务" });
        return running_tasks.forEach((v) =>
          send_task_info({ chat_id, task_id: v.id }).catch(console.error)
        );
      }
      send_task_info({ task_id, chat_id }).catch(console.error);
    } else {
      sm({ chat_id, text: "暂不支持此命令" });
    }
  } else {
    return send_choice({ fid, chat_id, note: text }).catch(console.error);
  }
});

module.exports = router;
