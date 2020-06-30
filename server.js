const dayjs = require("dayjs");
const Koa = require("koa");
const bodyParser = require("koa-bodyparser");

const { IP, PORT, SECRET } = require("./config.loader");
const router = require("./src/router");
const app = new Koa();
app.proxy = true;

app.use(async (ctx, next) => {
  if (SECRET && ctx.query.secret !== SECRET) {
    ctx.throw(403);
  }
  try {
    await next();
  } catch (e) {
    console.log(e.message);
    ctx.throw(500);
  }
});
app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());
app.listen(PORT, IP, console.log(`Listening on ${IP}:${PORT}`));
