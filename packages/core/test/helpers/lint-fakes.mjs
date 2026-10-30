// Lints fake core sources in THIS process (NB-01). purity.test.ts spawns it, so the
// fakes never enter the test process's typescript-eslint project service. They
// are linted as if they were packages/core/src/reducers/avatar.ts, which made the
// shared service serve fake text for the real file and flake the real-source test.
//
// stdin: JSON { root, filePath, cases: [{ name, code }] }
// stdout: JSON { [name]: ruleId[] }  (parse errors are reported as "parse")
import { ESLint } from 'eslint';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { root, filePath, cases } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const eslint = new ESLint({ cwd: root });
const out = {};
for (const { name, code } of cases) {
  const [result] = await eslint.lintText(code, { filePath });
  out[name] = (result?.messages ?? []).map((m) => m.ruleId ?? 'parse');
}
process.stdout.write(JSON.stringify(out));
