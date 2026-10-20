import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverScriptPath = path.resolve(__dirname, '../src/mcp-server.mjs');
const tempMcpRepo = path.resolve(__dirname, '.temp-mcp-repo');

function gitExec(args) {
  execFileSync('git', args, {
    cwd: tempMcpRepo,
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MCP Tester',
      GIT_AUTHOR_EMAIL: 'mcp@test.local',
      GIT_COMMITTER_NAME: 'MCP Tester',
      GIT_COMMITTER_EMAIL: 'mcp@test.local',
    },
  });
}

function setupTestGitRepo() {
  cleanupTestGitRepo();
  fs.mkdirSync(tempMcpRepo, { recursive: true });

  gitExec(['init', '-b', 'main']);

  // Commit 1: Initial baseline on main
  const pkg1 = {
    name: 'mcp-fixture-app',
    version: '1.0.0',
    type: 'module',
    dependencies: {},
  };
  fs.writeFileSync(path.join(tempMcpRepo, 'package.json'), JSON.stringify(pkg1, null, 2) + '\n');
  fs.writeFileSync(path.join(tempMcpRepo, 'index.js'), "console.log('clean app');\n");
  gitExec(['add', '.']);
  gitExec(['commit', '-m', 'initial baseline']);

  // Commit 2: Clean branch (used dependency)
  gitExec(['checkout', '-b', 'clean-feature']);
  const pkg2 = {
    name: 'mcp-fixture-app',
    version: '1.1.0',
    type: 'module',
    dependencies: {
      'used-package': '^1.0.0',
    },
  };
  fs.writeFileSync(path.join(tempMcpRepo, 'package.json'), JSON.stringify(pkg2, null, 2) + '\n');
  fs.writeFileSync(
    path.join(tempMcpRepo, 'index.js'),
    "import used from 'used-package';\nconsole.log(used);\n"
  );
  gitExec(['add', '.']);
  gitExec(['commit', '-m', 'add used package']);

  // Commit 3: Bloat branch (unused production dependency)
  gitExec(['checkout', 'main']);
  gitExec(['checkout', '-b', 'bloat-feature']);
  const pkg3 = {
    name: 'mcp-fixture-app',
    version: '1.2.0',
    type: 'module',
    dependencies: {
      'used-package': '^1.0.0',
      'unused-bloat-pkg': '^2.0.0',
    },
  };
  fs.writeFileSync(path.join(tempMcpRepo, 'package.json'), JSON.stringify(pkg3, null, 2) + '\n');
  gitExec(['add', 'package.json']);
  gitExec(['commit', '-m', 'add unused production dependency']);
}

function cleanupTestGitRepo() {
  if (fs.existsSync(tempMcpRepo)) {
    fs.rmSync(tempMcpRepo, { recursive: true, force: true });
  }
}

function spawnMcpClient() {
  const child = spawn(process.execPath, [serverScriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  const stdoutLines = [];
  const stderrChunks = [];

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk.toString());
  });

  rl.on('line', (line) => {
    stdoutLines.push(line);
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Non-JSON line handled by test assertions
    }
  });

  let nextId = 1;

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  const sendRaw = (rawString) => {
    return new Promise((resolve) => {
      const id = 'raw-' + Date.now();
      // Listen for the next output line
      const onLine = (line) => {
        rl.removeListener('line', onLine);
        resolve(line);
      };
      rl.on('line', onLine);
      child.stdin.write(rawString + '\n');
    });
  };

  const close = () => {
    return new Promise((resolve) => {
      child.stdin.end();
      child.on('close', resolve);
    });
  };

  return { request, notify, sendRaw, close, child, stdoutLines, stderrChunks };
}

describe('BOLT MCP Server — Integration and Protocol Compliance', () => {
  before(() => {
    setupTestGitRepo();
  });

  after(() => {
    cleanupTestGitRepo();
  });

  it('performs protocol handshake and initialization negotiation', async () => {
    const client = spawnMcpClient();

    const initResponse = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    assert.equal(initResponse.jsonrpc, '2.0');
    assert.ok(initResponse.result, 'Response must have result');
    assert.equal(initResponse.result.protocolVersion, '2024-11-05');
    assert.equal(initResponse.result.serverInfo.name, 'bolt');
    assert.equal(initResponse.result.serverInfo.version, '0.1.0');
    assert.deepEqual(initResponse.result.capabilities, { tools: {} });

    // Confirm notifications do not elicit responses
    client.notify('notifications/initialized', {});

    // Ping check
    const pingResponse = await client.request('ping', {});
    assert.equal(pingResponse.jsonrpc, '2.0');
    assert.deepEqual(pingResponse.result, {});

    await client.close();
  });

  it('discovers bolt_check_dependencies tool with schema definition and additionalProperties: false', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const listResponse = await client.request('tools/list', {});
    assert.equal(listResponse.jsonrpc, '2.0');
    assert.ok(Array.isArray(listResponse.result.tools));
    assert.ok(listResponse.result.tools.length >= 1);

    const tool = listResponse.result.tools.find((t) => t.name === 'bolt_check_dependencies');
    assert.ok(tool, 'bolt_check_dependencies must be present in tools list');
    assert.equal(tool.name, 'bolt_check_dependencies');
    assert.ok(tool.description.includes('production dependencies'));
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.repositoryRoot);
    assert.ok(tool.inputSchema.properties.base);
    assert.ok(tool.inputSchema.properties.staged);
    assert.ok(tool.inputSchema.properties.includeUntracked);

    await client.close();
  });

  it('evaluates clean dependency changes, explicitly asserting passing decision and exit code 0', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const cleanCall = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
      },
    });

    assert.equal(cleanCall.jsonrpc, '2.0');
    assert.equal(cleanCall.result.isError, false, 'Clean gate execution must have isError: false');
    assert.ok(cleanCall.result.content);
    assert.equal(cleanCall.result.content[0].type, 'text');

    const text = cleanCall.result.content[0].text;
    assert.ok(text.startsWith('⚡ BOLT — Policy Gate Report'), 'Must visibly begin with ⚡ BOLT');
    assert.ok(text.includes('Decision:  PASS (Exit code: 0)'), 'Must explicitly assert PASS and exit code 0');
    assert.ok(text.includes('Gate passed: all checks completed cleanly with zero blocking violations.'));
    assert.ok(!text.includes('Violations:'), 'Must have zero violations reported');

    await client.close();
  });

  it('detects seeded unused production dependency and returns blocked status with ⚡ BOLT', async () => {
    gitExec(['checkout', 'bloat-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, false, 'Policy failure is a clean tool run with blocked finding');

    const text = callResponse.result.content[0].text;
    assert.ok(text.startsWith('⚡ BOLT — Policy Gate Report'), 'Must visibly begin with ⚡ BOLT');
    assert.ok(text.includes('Decision:  BLOCKED (Exit code: 1)'), 'Must report BLOCKED status and exit code 1');
    assert.ok(text.includes('unused-bloat-pkg'), 'Must cite the violating package');
    assert.ok(text.includes('RULE-NO-UNNECESSARY-DEPENDENCIES'), 'Must cite the universal rule ID');

    await client.close();
  });

  it('evaluates staged index changes cleanly when staged: true is provided', async () => {
    gitExec(['checkout', 'main']);

    // Stage a clean dependency addition
    const stagedPkg = {
      name: 'mcp-fixture-app',
      version: '1.0.1',
      type: 'module',
      dependencies: {
        'staged-package': '^1.0.0',
      },
    };
    fs.writeFileSync(path.join(tempMcpRepo, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');
    fs.writeFileSync(path.join(tempMcpRepo, 'index.js'), "import sp from 'staged-package';\nconsole.log(sp);\n");
    gitExec(['add', 'package.json', 'index.js']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const stagedCall = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        staged: true,
      },
    });

    assert.equal(stagedCall.jsonrpc, '2.0');
    assert.equal(stagedCall.result.isError, false);
    const text = stagedCall.result.content[0].text;
    assert.ok(text.includes('Decision:  PASS (Exit code: 0)'), 'Staged clean change must pass');

    await client.close();

    // Reset staged index
    gitExec(['reset', '--hard', 'HEAD']);
  });

  it('evaluates changes with includeUntracked: true without error', async () => {
    gitExec(['checkout', 'main']);

    // Create an untracked file
    const untrackedFile = path.join(tempMcpRepo, 'untracked-helper.js');
    fs.writeFileSync(untrackedFile, "console.log('untracked');\n");

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const untrackedCall = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'HEAD',
        includeUntracked: true,
      },
    });

    assert.equal(untrackedCall.jsonrpc, '2.0');
    assert.equal(untrackedCall.result.isError, false);
    const text = untrackedCall.result.content[0].text;
    assert.ok(text.includes('Decision:  PASS (Exit code: 0)'));

    await client.close();

    // Cleanup untracked file
    if (fs.existsSync(untrackedFile)) {
      fs.rmSync(untrackedFile, { force: true });
    }
  });

  it('rejects invalid repository paths safely with isError: true and ⚡ BOLT prefix', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const nonExistentPath = path.join(tempMcpRepo, 'non-existent-subdir-12345');
    const callResponse = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: nonExistentPath,
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true, 'Inaccessible path must return isError: true');

    const text = callResponse.result.content[0].text;
    assert.ok(text.startsWith('⚡ BOLT — Validation Error'), 'Error text must begin with ⚡ BOLT');
    assert.ok(text.includes('does not exist'), 'Must specify path does not exist');

    await client.close();
  });

  it('rejects Git CLI option injection in base revision before any Git execution occurs', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    // Test long option flag (e.g. attempting to redirect output or hijack flags)
    const injectedFilePath = path.join(tempMcpRepo, 'injected-diff-output.txt');
    const optionCall = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: `--output=${injectedFilePath}`,
      },
    });

    assert.equal(optionCall.result.isError, true);
    assert.ok(optionCall.result.content[0].text.startsWith('⚡ BOLT — Validation Error'));
    assert.ok(optionCall.result.content[0].text.includes('Parameter base cannot start with a hyphen (-)'));
    assert.equal(fs.existsSync(injectedFilePath), false, 'Git --output must not have executed or created a file');

    // Test short option flag
    const shortFlagCall = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: '-p',
      },
    });

    assert.equal(shortFlagCall.result.isError, true);
    assert.ok(shortFlagCall.result.content[0].text.includes('Parameter base cannot start with a hyphen (-)'));

    await client.close();
  });

  it('rejects dangerous or invalid base revision strings containing shell/control characters', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'HEAD; rm -rf /',
      },
    });

    assert.equal(callResponse.result.isError, true);
    assert.ok(callResponse.result.content[0].text.startsWith('⚡ BOLT — Validation Error'));
    assert.ok(callResponse.result.content[0].text.includes('invalid revision characters'));

    await client.close();
  });

  it('rejects unexpected tool arguments to enforce additionalProperties: false', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        unexpectedProperty: 'malicious-or-mistaken-value',
      },
    });

    assert.equal(callResponse.result.isError, true);
    assert.ok(callResponse.result.content[0].text.startsWith('⚡ BOLT — Validation Error'));
    assert.ok(callResponse.result.content[0].text.includes("Unexpected argument 'unexpectedProperty' provided"));

    await client.close();
  });

  it('returns clean error for unknown tool call', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'unknown_tool',
      arguments: {},
    });

    assert.equal(callResponse.result.isError, true);
    assert.ok(callResponse.result.content[0].text.startsWith('⚡ BOLT — Error: Unknown tool'));

    await client.close();
  });

  it('returns parse error for malformed JSON without crashing server', async () => {
    const client = spawnMcpClient();

    const rawReply = await client.sendRaw('THIS IS NOT VALID JSON');
    const parsed = JSON.parse(rawReply);

    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, null);
    assert.equal(parsed.error.code, -32700);

    // Verify server remains alive and handles subsequent valid request
    const pingResponse = await client.request('ping', {});
    assert.equal(pingResponse.jsonrpc, '2.0');

    await client.close();
  });

  it('preserves protocol integrity: stdout contains exclusively valid JSON-RPC lines', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    await client.request('tools/list', {});

    await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
      },
    });

    await client.close();

    // Check every captured stdout line
    assert.ok(client.stdoutLines.length >= 3, 'Must have at least 3 responses');
    for (const line of client.stdoutLines) {
      assert.doesNotThrow(() => {
        const obj = JSON.parse(line);
        assert.equal(obj.jsonrpc, '2.0', 'Every stdout line must be a JSON-RPC 2.0 object');
      }, `Stdout line failed JSON parse: ${line}`);
    }
  });

  it('discovers bolt_post_implementation_gate tool with complete schema and additionalProperties: false', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const listResponse = await client.request('tools/list', {});
    assert.equal(listResponse.jsonrpc, '2.0');
    const tool = listResponse.result.tools.find((t) => t.name === 'bolt_post_implementation_gate');
    assert.ok(tool, 'bolt_post_implementation_gate must be present in tools list');
    assert.ok(tool.description.includes('Post-implementation quality gate'));
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.repositoryRoot);
    assert.ok(tool.inputSchema.properties.goal);
    assert.ok(tool.inputSchema.properties.diff);
    assert.ok(tool.inputSchema.properties.base);
    assert.ok(tool.inputSchema.properties.staged);
    assert.ok(tool.inputSchema.properties.includeUntracked);

    await client.close();
  });

  it('bolt_post_implementation_gate evaluates clean code change with goal and returns PASS with exit code 0', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
        goal: 'Add and integrate used package for application',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, false);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('⚡ BOLT — Post-Implementation Quality Gate Report'));
    assert.ok(text.includes('Verdict:   PASS (Exit code: 0)'));
    assert.ok(text.includes('Goal:      Add and integrate used package for application'));

    await client.close();
  });

  it('bolt_post_implementation_gate evaluates change without goal and caps verdict at PASS WITH WARNINGS', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, false);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('⚡ BOLT — Post-Implementation Quality Gate Report'));
    assert.ok(text.includes('Verdict:   PASS WITH WARNINGS (Exit code: 0)'));
    assert.ok(text.includes('Goal:      (Not provided — goal alignment unverified)'));

    await client.close();
  });

  it('bolt_post_implementation_gate evaluates demonstrable bloat and returns FAIL with exit code 1', async () => {
    gitExec(['checkout', 'bloat-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        base: 'main',
        goal: 'Add packages to repository',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('Verdict:   FAIL (Exit code: 1)'));
    assert.ok(text.includes('unused-bloat-pkg'));

    await client.close();
  });

  it('bolt_post_implementation_gate safely evaluates direct diff input without git execution', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const sampleDirectDiff = `diff --git a/src/sample.js b/src/sample.js
new file mode 100644
--- /dev/null
+++ b/src/sample.js
@@ -0,0 +1,6 @@
+import { unusedHelper } from './helpers.js';
+
+export function calculateTotal(items) {
+  return items.reduce((acc, item) => acc + item.price, 0);
+}
+`;

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        diff: sampleDirectDiff,
        goal: 'Calculate total order price across items',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('Verdict:   FAIL (Exit code: 1)'));
    assert.ok(text.includes("Unused import 'unusedHelper'"));

    await client.close();
  });

  it('bolt_post_implementation_gate rejects unexpected tool arguments', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        unknownFlag: true,
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true);
    assert.ok(callResponse.result.content[0].text.includes("Unexpected argument 'unknownFlag'"));

    await client.close();
  });

  it('bolt_check_dependencies evaluates unused dependency in direct diff even when package.json is not written to disk', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const unwrittenDepDiff = `diff --git a/package.json b/package.json
index 1234567..89abcdef 100644
--- a/package.json
+++ b/package.json
@@ -5,2 +5,3 @@
   "dependencies": {
+    "unwritten-bloat-pkg": "^1.0.0",
     "used-package": "^1.0.0"
`;

    const callResponse = await client.request('tools/call', {
      name: 'bolt_check_dependencies',
      arguments: {
        repositoryRoot: tempMcpRepo,
        diff: unwrittenDepDiff,
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, false);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('BLOCKED (Exit Code: 1)'));
    assert.ok(text.includes('unwritten-bloat-pkg'));

    await client.close();
  });

  it('bolt_post_implementation_gate evaluates unused dependency in direct diff even when package.json is not written to disk', async () => {
    gitExec(['checkout', 'clean-feature']);

    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const unwrittenDepDiff = `diff --git a/package.json b/package.json
index 1234567..89abcdef 100644
--- a/package.json
+++ b/package.json
@@ -5,2 +5,3 @@
   "dependencies": {
+    "unwritten-bloat-pkg": "^1.0.0",
     "used-package": "^1.0.0"
`;

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        diff: unwrittenDepDiff,
        goal: 'Add package to application',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('Verdict:   FAIL (Exit code: 1)'));
    assert.ok(text.includes('unwritten-bloat-pkg'));

    await client.close();
  });

  it('bolt_post_implementation_gate fails closed with exit code 2 when direct diff contains malformed package.json diff', async () => {
    const client = spawnMcpClient();

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    const malformedDiff = `diff --git a/package.json b/package.json
index 1234567..89abcdef 100644
--- a/package.json
+++ b/package.json
@@ -4,2 +4,3 @@
   "dependencies": {
+    "invalid-json": NOT VALID
`;

    const callResponse = await client.request('tools/call', {
      name: 'bolt_post_implementation_gate',
      arguments: {
        repositoryRoot: tempMcpRepo,
        diff: malformedDiff,
        goal: 'Add package to application',
      },
    });

    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, true);
    const text = callResponse.result.content[0].text;
    assert.ok(text.includes('Exit code: 2'));
    assert.ok(text.includes('Incomplete or malformed package.json diff'));

    await client.close();
  });
});
