// Node 24 的 `node --test tests/` 会把目录当作模块入口加载(而不是递归发现
// 目录下的 .test.ts),因此这里汇总 require 全部测试文件,让文档中的
// `node --test tests/` 与 `node --test tests/*.test.ts` 行为一致。
// 只依赖同步 require:Node 24 支持 require() 加载带类型剥离的 ESM .ts 文件。
const { readdirSync } = require("node:fs");

for (const file of readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()) {
  require(`./${file}`);
}
