import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  SCRUB_INPUT_MAX,
  SUMMARY_LIMITS,
  boundForScrub,
  capRedacted,
  REDACTED_ID,
  redactText,
  repoName,
  scrubId,
  scrubText,
  shortPath,
  summarizeTool,
  truncate,
} from '../src/redact.js';
import { classifyPrompt } from '../src/prompt.js';
import { MAX_SUMMARY, MAX_TEXT } from '../src/schema.js';

// Every planted secret is assembled at runtime so this file passes secret-scan.
const j = (...parts: string[]) => parts.join('');
const B64 = 'Qm9vbXNoYWthbGFrYTEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w';
const HEX40 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b';
const HEX64 = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

interface Planted {
  name: string;
  text: string;
  value: string;
}

const corpus: Planted[] = [
  { name: 'anthropic api key', value: j('sk-', 'ant-api03-', B64.slice(0, 40)), text: '' },
  { name: 'anthropic admin key', value: j('sk-', 'ant-admin01-', HEX40), text: '' },
  { name: 'github classic pat', value: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), text: '' },
  { name: 'github oauth', value: j('gh', 'o_', '16C7e42F292c6912E7710c838347Ae178B4a'), text: '' },
  { name: 'github server token', value: j('gh', 's_', 'abcdEFGH1234ijklMNOP5678qrstUVWX90yz'), text: '' },
  { name: 'github fine-grained pat', value: j('github', '_pat_', '11ABCDEFG0123456789_', B64.slice(0, 30)), text: '' },
  { name: 'aws access key id', value: j('AK', 'IA', 'IOSFODNN7EXAMPLE'), text: '' },
  { name: 'aws secret access key', value: j('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'), text: '' },
  { name: 'jwt bearer', value: j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0.abc'), text: '' },
  { name: 'short bearer', value: 'tok3n-short', text: '' },
  { name: 'lowercase bearer', value: 'lowercaseBearerValue', text: '' },
  { name: 'rsa private key block', value: j('MIIEvQIBADANBgkqhkiG9w0B', 'AQEFAASCBKcwggSjAgEAAoIBAQ'), text: '' },
  { name: 'openssh private key block', value: 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', text: '' },
  { name: 'truncated ec key block', value: 'MHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04f', text: '' },
  { name: 'password=', value: 'hunter2hunter2', text: '' },
  { name: 'passwd:', value: 's3cr3t!Pass', text: '' },
  { name: "secret='...'", value: 'myLittleSecret', text: '' },
  { name: 'token = ', value: 'plainTokenValue', text: '' },
  { name: 'api_key=', value: 'apikeyvalue_123', text: '' },
  { name: 'api-key:', value: 'dashkey.value', text: '' },
  { name: 'apikey=', value: 'nounderscorekey', text: '' },
  { name: 'GITHUB_TOKEN env', value: 'envTokenWithoutPrefix', text: '' },
  { name: 'json client_secret', value: 'clientSecretVal', text: '' },
  { name: 'json password', value: 'jsonPassw0rd', text: '' },
  { name: 'url userinfo https', value: 'alice:Pa55word', text: '' },
  { name: 'url userinfo postgres', value: 'admin:dbpass', text: '' },
  { name: 'hex 40 (sha-like token)', value: HEX40, text: '' },
  { name: 'hex 64', value: HEX64, text: '' },
  { name: 'base64 48', value: B64.slice(0, 48), text: '' },
  { name: 'base64url gen-token', value: 'q8Vt2LxZ_0aB-cD3eF4gH5iJ6kL7mN8oP9rS1tU2vW3', text: '' },
  { name: 'phone international', value: '+44 20 7946 0958', text: '' },
  { name: 'phone local', value: '0123456789', text: '' },
  { name: 'phone with dashes', value: '555-867-5309-12', text: '' },
  { name: 'slack-like long token', value: j('xo', 'xb-', '123456789012-abcdefABCDEF123456'), text: '' },
  // BUG-03 survivors (tester, 2026-10-20)
  { name: 'authorization basic', value: 'dXNlcjpodW50ZXIy', text: '' },
  { name: 'authorization basic long', value: 'YWRtaW46UzNjcjN0UGFzc3cwcmQh', text: '' },
  { name: 'DB_PASS env', value: 'hunter2xyz', text: '' },
  { name: 'MYSQL_PWD env', value: 'mysqlPwdVal', text: '' },
  { name: 'PRIVATE_KEY env', value: 'abc123privkey', text: '' },
  { name: 'STRIPE_KEY env (*_KEY)', value: 'stripeKeyVal9', text: '' },
  { name: 'stripe live key bare', value: j('sk', '_live_', 'abcDEF123456ghi'), text: '' },
  { name: 'quoted value with spaces', value: 'hunter 2 xyz', text: '' },
  { name: 'url password with slash', value: 'pa/ss/word9', text: '' },
  { name: 'url password with hash', value: 'pa#ss#word9', text: '' },
  { name: 'url password with @', value: 'p@ss@word9', text: '' },
  { name: 'aws sts key id (ASIA)', value: j('AS', 'IA', 'IOSFODNN7EXAMPLE'), text: '' },
  { name: 'pgp private key block', value: 'lQOYBFabcdefg', text: '' },
  { name: 'pgp block checksum line', value: '=Ab3xQ', text: '' },
  { name: 'zero-width split github token', value: j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9\u200bJ0k1L2m3N4o5P6q7R8'), text: '' },
  { name: 'zero-width in token prefix', value: j('g\u200bh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'), text: '' },
  { name: 'bidi split anthropic key', value: j('sk-', 'ant-\u202eapi03-', 'abcDEF123_xyz9'), text: '' },
  { name: 'jwt short payload (bare)', value: j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0.abc'), text: '' },
  // NB-03 (tester round 2, closed in V1-00)
  { name: 'quoted key, php arrow', value: 'arrowSecret9', text: '' },
  { name: 'walrus assignment', value: 'walrusSecret9', text: '' },
  { name: 'bash ansi-c quoted value', value: 'ansiCSecret9', text: '' },
  { name: 'backtick value', value: 'backtickSecr9', text: '' },
  { name: 'yaml block scalar value', value: 'yamlBlockSec9', text: '' },
  { name: 'bare pass=', value: 'barePassVal9', text: '' },
  { name: 'bare pwd=', value: 'barePwdValue9', text: '' },
  { name: 'json bare auth', value: 'bareAuthVal9', text: '' },
  { name: 'bare cookie=', value: 'bareCookieV9', text: '' },
  { name: 'cookie header, several pairs', value: 'cookiePair2Val', text: '' },
  { name: 'set-cookie header', value: 'setCookieVal9', text: '' },
  { name: 'nbsp separators', value: 'nbspSecretV9', text: '' },
  { name: 'fullwidth equals', value: 'fullEqSecret9', text: '' },
  { name: 'fullwidth colon', value: 'fullColonSec9', text: '' },
  { name: 'ideographic space separators', value: 'ideoSpaceSec9', text: '' },
  { name: 'authorization with nbsp', value: 'nbspAuthTok9', text: '' },
  { name: 'combining grapheme joiner split token', value: j('gh', 'p_', 'a1B2c3', '\u034f', 'D4e5F6'), text: '' },
  { name: 'tag character split token', value: j('gh', 'p_', 'a1B2c3', '\u{E0041}', 'D4e5F6'), text: '' },
  { name: 'url user part crossing /', value: 'us/er:slashUser9', text: '' },
];

// Wrap each secret in realistic surrounding text.
const wrap: Record<string, (s: string) => string> = {
  'jwt bearer': (s) => `Authorization: Bearer ${s}`,
  'short bearer': (s) => `curl -H "Authorization: Bearer ${s}" https://x.example`,
  'lowercase bearer': (s) => `header bearer ${s} sent`,
  'rsa private key block': (s) => j('-----BEGIN RSA ', 'PRIVATE KEY-----\n', s, '\nmore\n-----END RSA ', 'PRIVATE KEY-----'),
  'openssh private key block': (s) => j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\n', s, '\n-----END OPENSSH ', 'PRIVATE KEY-----'),
  'truncated ec key block': (s) => j('see -----BEGIN EC ', 'PRIVATE KEY-----\n', s),
  'password=': (s) => `login with password=${s} now`,
  'passwd:': (s) => `passwd: ${s}`,
  "secret='...'": (s) => `secret='${s}'`,
  'token = ': (s) => `token = ${s}`,
  'api_key=': (s) => `api_key=${s}`,
  'api-key:': (s) => `api-key: ${s}`,
  'apikey=': (s) => `apikey=${s}`,
  'GITHUB_TOKEN env': (s) => `export GITHUB_TOKEN=${s}`,
  'json client_secret': (s) => `{"client_secret": "${s}"}`,
  'json password': (s) => `{"password":"${s}","user":"x"}`,
  'url userinfo https': (s) => `clone https://${s}@github.com/org/repo.git`,
  'url userinfo postgres': (s) => `DATABASE_URL is postgres://${s}@db:5432/app`,
  'aws secret access key': (s) => `aws_secret_access_key = ${s}`,
  'phone international': (s) => `call me on ${s} later`,
  'phone local': (s) => `tel ${s}`,
  'authorization basic': (s) => `Authorization: Basic ${s}`,
  'authorization basic long': (s) => `curl -H 'authorization: basic ${s}' https://x`,
  'DB_PASS env': (s) => `DB_PASS=${s} psql`,
  'MYSQL_PWD env': (s) => `MYSQL_PWD=${s}`,
  'PRIVATE_KEY env': (s) => `PRIVATE_KEY=${s}`,
  'STRIPE_KEY env (*_KEY)': (s) => `STRIPE_KEY=${s}`,
  'quoted value with spaces': (s) => `password = "${s}"`,
  'url password with slash': (s) => `https://user:${s}@host.com/`,
  'url password with hash': (s) => `https://user:${s}@host.com/`,
  'url password with @': (s) => `https://user:${s}@host.com/x`,
  'pgp private key block': (s) =>
    j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n\n', s, '\nshortline\n=Ab3xQ\n-----END PGP ', 'PRIVATE KEY BLOCK-----'),
  'quoted key, php arrow': (s) => `['password' => '${s}']`,
  'walrus assignment': (s) => `password := "${s}"`,
  'bash ansi-c quoted value': (s) => `export DB_PASSWORD=$'${s}'`,
  'backtick value': (s) => j('token=`', s, '`'),
  'yaml block scalar value': (s) => `client_secret: |\n  ${s}\nother: 1`,
  'bare pass=': (s) => `login pass=${s} ok`,
  'bare pwd=': (s) => `PWD=${s}`,
  'json bare auth': (s) => `{"auth": "${s}"}`,
  'bare cookie=': (s) => `cookie=${s}`,
  'cookie header, several pairs': (s) => `curl -H 'Cookie: sid=abc; csrf=${s}' https://x`,
  'set-cookie header': (s) => `Set-Cookie: id=${s}; Path=/; HttpOnly`,
  'nbsp separators': (s) => `password\u00a0=\u00a0${s}`,
  'fullwidth equals': (s) => `token\uff1d${s}`,
  'fullwidth colon': (s) => `secret\uff1a ${s}`,
  'ideographic space separators': (s) => `api_key\u3000:\u3000${s}`,
  'authorization with nbsp': (s) => `Authorization:\u00a0Bearer\u00a0${s}`,
  'url user part crossing /': (s) => `git clone https://${s}@host.com/r.git`,
  'pgp block checksum line': (s) =>
    j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF\n', s, '\n-----END PGP ', 'PRIVATE KEY BLOCK----- after'),
};
for (const p of corpus) p.text = (wrap[p.name] ?? ((s: string) => `here is ${s} ok`))(p.value);

/** No 10-char window of the secret may survive. */
function survives(rawSecret: string, out: string): boolean {
  const secret = rawSecret.replace(/[\u200b\u202e]|\u034f|\u{E0041}/gu, '');
  const w = Math.min(10, secret.length);
  for (let i = 0; i + w <= secret.length; i++) {
    if (out.includes(secret.slice(i, i + w))) return true;
  }
  return false;
}

describe('redactText: planted secret corpus', () => {
  it('has at least 30 planted secrets', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30);
  });

  it.each(corpus.map((p) => [p.name, p] as const))('%s does not survive', (_n, p) => {
    const out = redactText(p.text);
    expect(out).toContain(REDACTED);
    expect(survives(p.value, out)).toBe(false);
  });

  it('0 of the corpus survives when all secrets are in one long text', () => {
    const all = corpus.map((p) => p.text).join('\n');
    const out = scrubText(all);
    const survivors = corpus.filter((p) => survives(p.value, out)).map((p) => p.name);
    expect(survivors).toEqual([]);
  });

  it('is idempotent on every corpus entry', () => {
    for (const p of corpus) {
      const once = redactText(p.text);
      expect(redactText(once)).toBe(once);
    }
  });
});

describe('redactText: benign text is preserved', () => {
  const benign = [
    'Edit src/data/about.ts and run npm test',
    'packages/core/src/reducers/session.ts',
    'node_modules/typescript/lib/typescript.js',
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is documented',
    'The architect reviewed the plan. Found 3 open questions.',
    'Fixed in v2 of packages/core/test/fixtures/v2/abc123',
    'Ran 42 tests in 1.5s',
    '<img src=x onerror=alert(1)>',
  ];
  it.each(benign)('%s', (t) => {
    expect(redactText(t)).toBe(t);
  });

  it('keeps the key name when redacting key=value', () => {
    expect(scrubText(j('password', '=abc'))).toBe(`password=${REDACTED}`);
  });
});

describe('length caps', () => {
  it('free text is capped at 500 and marked with an ellipsis', () => {
    const out = redactText('word '.repeat(400));
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const s = `${'a'.repeat(8)}😀😀😀`;
    for (let max = 1; max <= s.length; max++) {
      const out = truncate(s, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it('truncate edge cases', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('ab…');
    expect(truncate('abcd', 0)).toBe('');
  });

  it('a cut inside a marker still converges (idempotent)', () => {
    const s = `${'x '.repeat(5)}${j('token', '=abcdef')} tail`;
    for (let max = 5; max < s.length + 2; max++) {
      const once = capRedacted(s, max);
      expect(once.length).toBeLessThanOrEqual(max);
      expect(capRedacted(once, max)).toBe(once);
    }
  });

  it('is idempotent on deterministic pseudo-random text', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = 'abcXYZ0189/_-=+ :."\'\n@';
    for (let n = 0; n < 300; n++) {
      let s = '';
      const len = Math.floor(rnd() * 120);
      for (let i = 0; i < len; i++) s += alphabet.charAt(Math.floor(rnd() * alphabet.length));
      const max = 10 + Math.floor(rnd() * 100);
      const once = capRedacted(s, max);
      expect(once.length).toBeLessThanOrEqual(max);
      expect(capRedacted(once, max)).toBe(once);
    }
  });
});

describe('summarizeTool (plan §11 table)', () => {
  const cwd = '/home/user/my-project';
  const cases: [string, string, unknown, string | undefined, string][] = [
    ['Read inside cwd', 'Read', { file_path: '/home/user/my-project/docs/build-plan.md' }, cwd, 'docs/build-plan.md'],
    ['Read single segment', 'Read', { file_path: '/home/user/my-project/README.md' }, cwd, 'README.md'],
    ['Read outside cwd', 'Read', { file_path: '/etc/ssh/sshd_config' }, cwd, 'ssh/sshd_config'],
    ['Edit deep path', 'Edit', { file_path: '/home/user/my-project/packages/core/src/a.ts', old_string: 'x' }, cwd, 'src/a.ts'],
    ['Write', 'Write', { file_path: '/home/user/my-project/src/x.ts', content: 'SECRET CONTENT' }, cwd, 'src/x.ts'],
    ['NotebookEdit', 'NotebookEdit', { notebook_path: '/home/user/my-project/nb/a.ipynb' }, cwd, 'nb/a.ipynb'],
    ['Windows path', 'Edit', { file_path: 'C:\\Claude\\portfolio\\src\\data\\about.ts' }, 'C:\\Claude\\portfolio', 'data/about.ts'],
    ['Windows case-insensitive cwd', 'Read', { file_path: 'c:\\claude\\portfolio\\README.md' }, 'C:\\Claude\\portfolio', 'README.md'],
    ['Bash first 2 tokens', 'Bash', { command: 'npm run build -- --mode production' }, cwd, 'npm run'],
    ['Bash leading whitespace', 'Bash', { command: '   git   status  ' }, cwd, 'git status'],
    ['PowerShell', 'PowerShell', { command: 'Get-ChildItem -Recurse -Filter *.ts' }, cwd, 'Get-ChildItem -Recurse'],
    ['Grep pattern', 'Grep', { pattern: 'DECISION REQUIRED', path: '/x' }, cwd, 'DECISION REQUIRED'],
    ['Glob pattern', 'Glob', { pattern: 'packages/**/*.ts' }, cwd, 'packages/**/*.ts'],
    ['WebFetch hostname only', 'WebFetch', { url: 'https://code.claude.com/docs/en/hooks.md?q=1' }, cwd, 'code.claude.com'],
    ['WebFetch invalid url', 'WebFetch', { url: 'not a url' }, cwd, ''],
    ['WebSearch', 'WebSearch', { query: 'pixijs isometric depth sorting' }, cwd, 'pixijs isometric depth sorting'],
    ['Agent', 'Agent', { subagent_type: 'architect', description: 'Review the plan', prompt: 'LONG PROMPT' }, cwd, 'architect: Review the plan'],
    ['Agent no description', 'Agent', { subagent_type: 'tester' }, cwd, 'tester'],
    ['Task (legacy name)', 'Task', { description: 'Find files' }, cwd, 'Find files'],
    ['MCP tool name only', 'mcp__memory__create_entities', { entities: [{ name: 'private' }] }, cwd, ''],
    ['unknown tool', 'SomethingNew', { anything: 'x' }, cwd, ''],
    ['missing input', 'Read', undefined, cwd, ''],
    ['non-object input', 'Bash', 'npm test', cwd, ''],
  ];
  it.each(cases)('%s', (_n, tool, input, c, expected) => {
    expect(summarizeTool(tool, input, c)).toBe(expected);
  });

  it('scrubs secrets in the kept part of a command', () => {
    const out = summarizeTool('Bash', { command: j('export GITHUB_TOKEN=', 'gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8') }, cwd);
    expect(out).toBe('export GITHUB_TOKEN=…');
    expect(summarizeTool('Bash', { command: j('gh auth ', 'gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8') }, cwd)).toBe('gh auth');
    const tok = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    expect(summarizeTool('Bash', { command: `git ${tok}` }, cwd)).toBe(`git ${REDACTED}`);
  });

  it('scrubs secrets in queries, patterns and descriptions', () => {
    const tok = j('sk-', 'ant-api03-', B64.slice(0, 30));
    for (const [tool, input] of [
      ['WebSearch', { query: `why ${tok}` }],
      ['Grep', { pattern: tok }],
      ['Agent', { subagent_type: 'coder', description: `use ${tok}` }],
    ] as const) {
      expect(summarizeTool(tool, input, cwd)).not.toContain('api03');
    }
  });

  it('respects per-field caps and the 120 overall cap', () => {
    expect(summarizeTool('Grep', { pattern: 'p'.repeat(100) }, cwd).length).toBeLessThanOrEqual(SUMMARY_LIMITS.pattern);
    expect(summarizeTool('WebSearch', { query: 'q '.repeat(100) }, cwd).length).toBeLessThanOrEqual(SUMMARY_LIMITS.query);
    const agent = summarizeTool('Agent', { subagent_type: 't'.repeat(90), description: 'd '.repeat(100) }, cwd);
    expect(agent.length).toBeLessThanOrEqual(MAX_SUMMARY);
    const longPath = summarizeTool('Read', { file_path: `/a/${'b'.repeat(200)}/c.ts` }, cwd);
    expect(longPath.length).toBeLessThanOrEqual(MAX_SUMMARY);
  });

  it('never includes raw tool_input content', () => {
    const out = summarizeTool('Write', { file_path: '/home/user/my-project/a.ts', content: 'CONTENT-XYZ' }, cwd);
    expect(out).not.toContain('CONTENT-XYZ');
  });
});

describe('repoName and shortPath', () => {
  it.each([
    ['/home/user/my-project', 'my-project'],
    ['/home/user/my-project/', 'my-project'],
    ['C:\\Claude\\portfolio', 'portfolio'],
    ['C:\\Claude\\portfolio\\', 'portfolio'],
    ['/', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('repoName(%s) = %s', (cwd, expected) => {
    expect(repoName(cwd)).toBe(expected);
  });

  it('shortPath without cwd keeps the last 2 segments', () => {
    expect(shortPath('/a/b/c/d.ts')).toBe('c/d.ts');
    expect(shortPath('d.ts')).toBe('d.ts');
  });

  it('shortPath does not treat a sibling prefix as inside cwd', () => {
    expect(shortPath('/home/user/my-project-2/x/y.ts', '/home/user/my-project')).toBe('x/y.ts');
    expect(shortPath('/home/user/my-project-2/y.ts', '/home/user/my-project')).toBe('my-project-2/y.ts');
  });
});

describe('BUG-12: benign values are not redacted', () => {
  it.each([
    'on 2026-10-20 at 12:00',
    'at 2026-10-20T12:00:00Z',
    'at 2026-10-20 12:00:00',
    'id 123e4567-e89b-12d3-a456-426614174000',
    'set max_tokens=4000',
    '"max_tokens": 8192',
    'Ran 1500 tests',
    // NB-03: the bare keys only count as whole words, and flag-like values stay.
    'Tests pass: 42, fail: 0',
    'auth: true',
    'author: Alice',
    'bypass: yes',
    'oauthFlow done',
    'pass=1234',
    '日本語：テスト',
    'https://www.npmjs.com/package/@scope/pkg',
    'flag 🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} ok',
    'family 👨\u200d👩\u200d👧 ok',
  ])('%s', (t) => {
    expect(redactText(t)).toBe(t);
  });

  it('a numeric password is still a secret', () => {
    expect(redactText('password=4000')).toBe(`password=${REDACTED}`);
  });
});

describe('BUG-02: shell summaries never keep credentials', () => {
  const cwd = '/home/user/my-project';
  const pw = 'hunter2';
  const cases: [string, string, string][] = [
    ['Bash', `DB_PASS=${pw} psql -h x`, 'DB_PASS=… psql'],
    ['Bash', `PGPASSWORD=${pw} psql`, 'PGPASSWORD=… psql'],
    ['Bash', `A=1 B=${pw} cmd`, 'A=… B=…'],
    ['Bash', `mysql -p${pw} db`, 'mysql -p…'],
    ['Bash', `curl -uadmin:${pw} https://x`, 'curl -u…'],
    ['Bash', `sshpass -p${pw} ssh host`, 'sshpass -p…'],
    ['Bash', `echo ${pw} | sudo -S x`, 'echo'],
    ['Bash', `printf '%s' ${pw}`, 'printf'],
    ['Bash', `/usr/bin/echo ${pw}`, '/usr/bin/echo'],
    ['Bash', `mysql --password=${pw} db`, 'mysql --password=…'],
    ['Bash', `env SECRET=${pw} node x`, 'env SECRET=…'],
    ['Bash', `export FOO=${pw}`, 'export FOO=…'],
    ['Bash', `curl https://admin:${pw}@h.com/x`, `curl https://${REDACTED}@h.com/x`],
    ['Bash', 'a‮b c', 'ab c'],
    ['PowerShell', `$env:API_KEY="${pw}"; npm test`, '$env:API_KEY=… npm'],
    ['PowerShell', `Write-Host ${pw}`, 'Write-Host'],
    ['PowerShell', 'Get-ChildItem -Recurse -Filter *.ts', 'Get-ChildItem -Recurse'],
    // V1-00-1: quoted values with spaces stay inside their word.
    ['Bash', `PASS='hunter secret2' ./run.sh`, 'PASS=… ./run.sh'],
    ['Bash', `API_TOKEN="abc def${pw}" npm start`, 'API_TOKEN=… npm'],
    ['Bash', `MYSQL_PWD="p ${pw}" mysql db`, 'MYSQL_PWD=… mysql'],
    ['Bash', `PASS=$'abc ${pw}' ./run.sh`, 'PASS=… ./run.sh'],
    ['Bash', `TOKEN=\`a ${pw}\` make`, 'TOKEN=… make'],
    ['Bash', `PASS="a \\" ${pw}" go`, 'PASS=… go'],
    ['Bash', `PASS=$'a \\' ${pw}' go`, 'PASS=… go'],
    ['Bash', `PASS=a\\ ${pw} go`, 'PASS=… go'],
    ['Bash', `A='x y' B="${pw} z" cmd arg`, 'A=… B=…'],
    ['Bash', `npm --token="a ${pw}" i`, 'npm --token=…'],
    ['Bash', `git commit -m "fix ${pw}"`, 'git commit'],
    ['Bash', `PASS='unterminated ${pw} more`, 'PASS=…'],
    ['Bash', `cmd 'unterminated ${pw}`, 'cmd'],
    ['Bash', `'unterminated ${pw}`, ''],
    ['Bash', `PASS="line1\n${pw}" run`, 'PASS=… run'],
    ['PowerShell', `$env:TOKEN='a ${pw}'; npm test`, '$env:TOKEN=… npm'],
    ['PowerShell', `$env:TOKEN="a \`" ${pw}"; npm test`, '$env:TOKEN=… npm'],
    ['PowerShell', 'Set-Location C:\\Users\\po; dir', 'Set-Location C:\\Users\\po;'],
    // V1-00-3: a cookie glued to -b
    ['Bash', `curl -bsid=${pw} https://x`, 'curl -b…'],
    ['Bash', `curl -b 'session=${pw}' https://x`, 'curl -b'],
    ['Bash', `curl --cookie=sid=${pw} https://x`, 'curl --cookie=…'],
  ];
  it.each(cases)('%s %s -> %s', (tool, command, expected) => {
    const out = summarizeTool(tool, { command }, cwd);
    expect(out).toBe(expected);
    expect(out).not.toContain(pw);
  });
});

describe('V1-00: cookies and quoted shell values', () => {
  const tail = j('TAILsess1on', 'SecretXYZ');
  it('V1-00-2: text after a >4 KB cookie value is redacted to the end of the line', () => {
    const out = scrubText(`Cookie: ${'x'.repeat(5000)} ${tail} more\nnext line`);
    expect(out).toBe(`Cookie: ${REDACTED}\nnext line`);
    const out2 = scrubText(`Cookie: ${'ab '.repeat(1400)}${j('SECRET', 'TAIL')}`);
    expect(out2).toBe(`Cookie: ${REDACTED}`);
    expect(scrubText(out2)).toBe(out2);
  });
  it('a cookie value of 4095 / 4096 characters ends at a quote or the line end', () => {
    expect(scrubText(`-H 'Cookie: ${'y'.repeat(4095)}' ok`)).toBe(`-H 'Cookie: ${REDACTED}' ok`);
    expect(scrubText(`Cookie: ${'y'.repeat(4096)}`)).toBe(`Cookie: ${REDACTED}`);
  });

  const secret = j('abc', '123xyz');
  const curl: [string, string][] = [
    [`curl -b 'session=${secret}' https://x`, `curl -b '${REDACTED}' https://x`],
    [`curl -b "sid=${secret}; csrf=${secret}" https://x`, `curl -b "${REDACTED}" https://x`],
    [`curl -b sid=${secret} https://x`, `curl -b ${REDACTED} https://x`],
    [`curl -bsid=${secret} https://x`, `curl -b${REDACTED} https://x`],
    [`curl --cookie "sid=${secret}" https://x`, `curl --cookie "${REDACTED}" https://x`],
    [`curl --cookie=sid=${secret} https://x`, `curl --cookie=${REDACTED} https://x`],
    [`curl --cookie 'sid=${secret}`, `curl --cookie '${REDACTED}'`],
  ];
  it.each(curl)('V1-00-3: %s', (input, expected) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(secret);
    expect(scrubText(out)).toBe(out);
  });
  it.each([
    'git checkout -b feature/x',
    'curl -b cookies.txt https://x',
    'git switch -B main',
    "curl --cookie '' https://x",
  ])('keeps a -b value that is not a cookie pair: %s', (t) => {
    expect(scrubText(t)).toBe(t);
  });
  it.each(['cookie: yes', 'Cookie: true', 'cookie=true', 'cookie: off.'])('a flag-word cookie value is kept: %s', (t) => {
    expect(scrubText(t)).toBe(t);
  });
  it('a real cookie header value is still redacted', () => {
    expect(scrubText(`cookie: yes=${secret}`)).toBe(`cookie: ${REDACTED}`);
  });
});

describe('boundForScrub', () => {
  it('leaves short input alone', () => {
    expect(boundForScrub('abc', 10)).toBe('abc');
  });
  it('drops a word cut in half', () => {
    expect(boundForScrub('aaa bbbbbb', 6)).toBe('aaa …');
  });
  it('keeps a cut at a space', () => {
    expect(boundForScrub('aaa bbb', 3)).toBe('aaa…');
  });
  it('keeps the head of one huge run (judged whole by the long-run rule)', () => {
    expect(boundForScrub('x'.repeat(SCRUB_INPUT_MAX * 2))).toBe(`${'x'.repeat(SCRUB_INPUT_MAX)}…`);
  });
  it('never leaves half a short secret past the cut', () => {
    const text = `${'word '.repeat(SCRUB_INPUT_MAX / 5 - 1)}tok${j('en', '=hunt', 'er2')}`;
    const out = boundForScrub(text);
    expect(out).not.toContain('hunt');
  });
});

// BUG-01: every rule must be linear. The tester's inputs took 0.6 s - 37 s.
describe('BUG-01: redaction cost is bounded (64 KB worst cases < 50 ms)', () => {
  const N = 64 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const hex = Array.from({ length: N }, (_, i) => '0123456789abcdef'.charAt((i * 7919) % 16)).join('');
  const inputs: [string, string][] = [
    ['token repeated', fill('token')],
    ['password repeated', fill('password')],
    ['a run', fill('a')],
    ['hex', hex],
    ['scheme-like a+', fill('a+')],
    ['url userinfo starts', fill('http://a:')],
    ['dashes', fill('-')],
    ['key block starts', fill('-----BEGIN KEY-----')],
    ['digits and spaces', fill('1 ')],
    ['digits and dashes', fill(`1${' -'.repeat(20)}x`)],
    ['jwt starts', fill('-eyJ')],
    ['key=value chain', fill('a=')],
    ['quotes', fill('password="')],
    ['authorization', fill('authorization: ')],
    ['bearer', fill('Bearer ')],
    ['basic', fill('Basic ')],
    ['zero-width', fill('a​')],
    ['prose', fill('The token budget and the password policy were discussed; secret handling is fine. ')],
    ['minified js', fill('var a_token_b=function(c){return c+1};')],
    ['phone-ish', fill('+1 2-3 ')],
    ['whitespace then marker', fill('   \n\t ')],
    // NB-03 rules
    ['cookie headers', fill('cookie: ')],
    ['set-cookie no value', fill('set-cookie:')],
    ['nbsp separators', fill('password\u00a0=\u00a0')],
    ['fullwidth separators', fill('token\uff1d\uff1a')],
    ['walrus and arrow', fill('pass:==>')],
    ['yaml block indicators', fill('secret: |\n')],
    ['ansi-c quote starts', fill("pwd=$'")],
    ['backtick starts', fill('auth=`')],
    ['bare keys', fill('pass pwd auth cookie ')],
    ['userinfo with slashes', fill('http://a/b/')],
    ['userinfo colon slashes', fill('http:///:')],
    ['combining joiner', fill('a\u034f')],
    ['tag characters', fill('a\u{E0041}')],
    // V1-00 rules
    ['long cookie value', `Cookie: ${'x'.repeat(N)}`],
    ['cookie then quotes', fill('cookie: a"')],
    ['curl -b quote starts', fill("-b'")],
    ['curl -b double quote starts', fill('-b "')],
    ['curl --cookie starts', fill("--cookie '")],
    ['curl -b chain', fill('-b -b=')],
    ['curl mixed quotes', fill(`-b'"-b"'`)],
    ['shell quote starts', fill("A='")],
    ['shell dquote and escapes', fill('A="\\')],
    ['shell ansi-c starts', fill("$'")],
    ['shell backticks', fill('`')],
    ['shell escapes', fill('\\')],
  ];
  const time = (f: () => unknown): number => {
    f(); // warm up the regex JIT
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it.each(inputs)('%s', (_n, input) => {
    expect(time(() => redactText(input))).toBeLessThan(50);
    expect(time(() => scrubText(input))).toBeLessThan(50);
    expect(time(() => classifyPrompt(input))).toBeLessThan(50);
    for (const tool of ['Bash', 'Grep', 'WebSearch', 'ToolSearch', 'SubagentHandback', 'Agent', 'Read']) {
      const tInput = { command: input, pattern: input, query: input, message: input, description: input, subagent_type: input, file_path: input };
      expect(time(() => summarizeTool(tool, tInput))).toBeLessThan(50);
    }
  });
  it.each(inputs)('scrubId: %s', (_n, input) => {
    expect(time(() => scrubId(input))).toBeLessThan(50);
    expect(time(() => scrubId(input.slice(0, 200)))).toBeLessThan(50);
  });
  it('Bash heredoc summary', () => {
    const command = `cat > x.b64 <<EOF\n${hex}\nEOF`;
    expect(time(() => summarizeTool('Bash', { command }))).toBeLessThan(50);
    expect(summarizeTool('Bash', { command })).toBe('cat >');
  });
});

// B-09: ids get the known-secret rules only; real ids never change.
describe('scrubId (B-09)', () => {
  const real: [string, string][] = [
    ['hook session_id (PC and cloud payloads are UUIDs)', '96f2a5f6-faa7-4d67-a443-ed835d571ed2'],
    ['all-digit UUID start (not a phone)', '12345678-1234-1234-1234-123456789012'],
    ['cloud remote id (cse_ + 24 base62, S1/S2 shape)', 'cse_01AbCdEfGhIjKlMnOpQrStUv'],
    ['session_ form of a cloud id', 'session_01AbCdEfGhIjKlMnOpQrStUv'],
    ['tool_use_id', 'toolu_013uebXMgPwWr7weddD2bTfZ'],
    ['long provider tool id', 'toolu_bdrk_01AbCdEfGhIjKlMnOpQrStUvWx'],
    ['agent_id', 'a452e0c2eab0c7f08'],
    ['request id (64-hex event id)', '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'],
    ['bridge run id', 'run_1'],
    ['plain test id', 'sess-1'],
  ];
  it.each(real)('%s is unchanged', (_n, id) => {
    expect(scrubId(id)).toBe(id);
  });

  const bad: [string, string][] = [
    ['github token', j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0')],
    ['anthropic key inside an id', j('x-sk-', 'ant-api03-', 'abc')],
    ['key=value', j('pass', 'word=hunter2')],
    ['jwt', j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0.abc')],
    ['aws key id', j('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['zero-width character', 'sess\u200b1'],
    ['bidi override', 'sess\u202e1'],
    ['url userinfo', 'https://u:p@h'],
    ['overlong', 'a'.repeat(300)],
  ];
  it.each(bad)('%s becomes the whole-id stand-in', (_n, id) => {
    expect(scrubId(id)).toBe(REDACTED_ID);
  });

  it('is idempotent and the stand-in fits the id charsets', () => {
    expect(scrubId(REDACTED_ID)).toBe(REDACTED_ID);
    expect(REDACTED_ID).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
