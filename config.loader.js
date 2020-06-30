const INTETER_CONFIG_KEYS = ["PORT"];

const config = {
  IP: "0.0.0.0",
  PORT: 23333,
  HTTPS_PROXY: "",
  SECRET: "",
  TIMEOUT_BASE: 7000,
  // 最大超时设置，比如某次请求，第一次7s超时，第二次14s，第三次28s，第四次56s，第五次不是112s而是60s，后续同理
  TIMEOUT_MAX: 60000,
  LOG_DELAY: 5000, // 日志输出时间间隔，单位毫秒
  PAGE_SIZE: 1000, // 每次网络请求读取目录下的文件数，数值越大，越有可能超时，不得超过1000
  RETRY_LIMIT: 7, // 如果某次请求失败，允许其重试的最大次数
  PARALLEL_LIMIT: 20, // 网络请求的并行数量，可根据网络环境调整
  DEFAULT_TARGET: "", // 必填，拷贝默认目的地ID，如果不指定target，则会复制到此处，建议填写团队盘ID
  AUTH: {
    // 如果您拥有service account的json授权文件，可将其拷贝至 sa 目录中以代替 client_id/secret/refrest_token
    client_id: "your_client_id",
    client_secret: "your_client_secret",
    refresh_token: "your_refrest_token",
    expires: 0, // 可以留空
    access_token: "", // 可以留空
    tg_token: "bot_token", // 你的 telegram robot 的 token，获取方法参见 https://core.telegram.org/bots#6-botfather
    tg_whitelist: ["your_tg_username"] // 你的tg username(t.me/username)，bot只会执行这个列表里的用户所发送的指令
  }
};

try {
  Object.assign(config, require("./config"));
} catch (e) {}

Object.keys(config).forEach((key) => {
  if (process.env[key]) {
    config[key] = process.env[key];
  }
});

INTETER_CONFIG_KEYS.forEach(
  (key) => (config[key] = parseInt(config[key]) || 0)
);
if (typeof config.AUTH == "string") {
  try {
    config.AUTH = JSON.parse(config.AUTH);
  } catch (e) {}
}
config.AUTH = config.AUTH || {};

module.exports = config;
