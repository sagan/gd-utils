const path = require("path");
const fs = require("fs");
const db_location = path.join(__dirname, "gdurl.sqlite");
const db = require("better-sqlite3")(db_location);
db.pragma("journal_mode = WAL");

module.exports = { db };

if (require.main === module) {
  main(process.argv.slice(2));
}

async function main(args) {
  if (args[0] === "rebuild") {
    console.log("rebuild sqlite");
    db.exec(fs.readFileSync(path.join(__dirname, "create-table.sql"), "utf8"));
    db.close();
  }
}
