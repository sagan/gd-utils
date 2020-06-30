const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const prompts = require("prompts");
const pLimit = require("p-limit");
const axios = require("@viegg/axios");
const HttpsProxyAgent = require("https-proxy-agent");
const { GoogleToken } = require("gtoken");
const handle_exit = require("signal-exit");

const { db } = require("../db");
const { real_copy } = require("../src/gd");
const { DEFAULT_TARGET } = require("../config.loader");

(async () => {
  let args = process.argv.slice(2);
  db.exec(fs.readFileSync(path.join(__dirname, "../create-table.sql"), "utf8"));
  await real_copy({
    source: args[0],
    target: DEFAULT_TARGET,
    name: "Source",
    note: "test note",
    not_teamdrive: true,
    service_account: true,
    is_server: true
  });
})();
