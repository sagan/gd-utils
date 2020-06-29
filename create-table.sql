drop index IF EXISTS "gd_fid";
drop index IF EXISTS "task_source_target";
drop table IF EXISTS "gd";
drop table IF EXISTS "task";

CREATE TABLE "gd" (
  "id"  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT UNIQUE,
  "fid" TEXT NOT NULL UNIQUE,
  "info"  TEXT,
  "summary" TEXT,
  "subf"  TEXT,
  "ctime" INTEGER,
  "mtime" INTEGER
);

CREATE UNIQUE INDEX "gd_fid" ON "gd" (
  "fid"
);

CREATE TABLE "task" (
  "id"  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT UNIQUE,
  "source"  TEXT NOT NULL,
  "target"  TEXT NOT NULL,
  "status" TEXT,
  "copied"  TEXT DEFAULT '',
  "mapping" TEXT DEFAULT '',
  "name" TEXT DEFAULT '',
  "note" TEXT DEFAULT '',
  "ctime" INTEGER,
  "ftime" INTEGER
);

CREATE UNIQUE INDEX "task_source_target" ON "task" (
  "source",
  "target"
);
