import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runGate } from './gate-runner.mjs';
import { EXIT_CODES } from './constants.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'bolt';
export const SERVER_VERSION = '0.1.0';

export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'bolt_check_dependencies',
    description:
      'Evaluates Git changes in a Node.js repository to detect newly added production dependencies in package.json that are never referenced in project source code. Returns deterministic policy decisions and line citations.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryRoot: {
          type: 'string',
          description:
            'Absolute or relative path to the local repository root (defaults to current working directory).',
        },
        base: {
          type: 'string',
          description:
            'Base Git revision, branch, or commit to compare against (e.g. "HEAD~1", "origin/main").',
        },
        staged: {
          type: 'boolean',
          description:
            'If true, checks only currently staged Git index changes rather than a commit revision.',
        },
        includeUntracked: {
          type: 'boolean',
          description:
            'If true, includes untracked files in the change inspection.',
        },
        diff: {
          type: 'string',
          description:
            'Optional direct unified diff string to evaluate changes without running git diff.',
        },
      },
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'bolt_post_implementation_gate',
    description:
      'Post-implementation quality gate. Evaluates completed code changes after an implementation step to verify goal alignment, detect unnecessary abstractions, dead code, silent error swallowing, excessive defensive code, and dependency bloat. Returns an evidence-based report with a verdict of PASS, PASS WITH WARNINGS, or FAIL.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'Original feature request, bug description, or intended implementation goal.',
        },
        repositoryRoot: {
          type: 'string',
          description:
            'Absolute or relative path to the local repository root (defaults to current working directory).',
        },
        base: {
          type: 'string',
          description:
            'Base Git revision, branch, or commit to compare against (e.g. "HEAD~1", "origin/main").',
        },
        staged: {
          type: 'boolean',
          description:
            'If true, checks only currently staged Git index changes rather than a commit revision.',
        },
        includeUntracked: {
          type: 'boolean',
          description:
            'If true, includes untracked files in the change inspection.',
        },
        diff: {
          type: 'string',
          description:
            'Optional direct unified diff string to evaluate changes without running git diff.',
        },
      },
      additionalProperties: false,
    },
  }),
]);

export const ALLOWED_DEPENDENCY_ARGUMENTS = Object.freeze([
  'repositoryRoot',
  'base',
  'staged',
  'includeUntracked',
  'diff',
]);

export const ALLOWED_POST_IMPLEMENTATION_ARGUMENTS = Object.freeze([
  'repositoryRoot',
  'base',
  'staged',
  'includeUntracked',
  'goal',
  'diff',
]);

export const ALLOWED_TOOL_ARGUMENTS = ALLOWED_DEPENDENCY_ARGUMENTS;

/**
 * Validates tool call parameters defensively before invoking the core engine.
 *
 * @param {object} args - Tool arguments
 * @param {string} [toolName='bolt_check_dependencies'] - Invoked tool name
 * @returns {{ valid: boolean, error?: string, sanitized?: object }}
 */
export function validateToolArguments(args = {}, toolName = 'bolt_check_dependencies') {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { valid: false, error: 'Arguments must be a valid object.' };
  }

  const allowedList = toolName === 'bolt_post_implementation_gate'
    ? ALLOWED_POST_IMPLEMENTATION_ARGUMENTS
    : ALLOWED_DEPENDENCY_ARGUMENTS;

  const allowedSet = new Set(allowedList);
  const unexpectedKeys = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unexpectedKeys.length > 0) {
    return {
      valid: false,
      error: `Unexpected argument '${unexpectedKeys[0]}' provided. Supported arguments: ${allowedList.join(', ')}.`,
    };
  }

  const sanitized = {};

  if (args.repositoryRoot !== undefined) {
    if (typeof args.repositoryRoot !== 'string' || args.repositoryRoot.trim() === '') {
      return { valid: false, error: 'Parameter repositoryRoot must be a non-empty string.' };
    }
    const resolvedPath = path.resolve(args.repositoryRoot);
    if (!fs.existsSync(resolvedPath)) {
      return { valid: false, error: `Repository directory does not exist: ${resolvedPath}` };
    }
    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return { valid: false, error: `Repository path is not a directory: ${resolvedPath}` };
      }
    } catch (err) {
      return { valid: false, error: `Cannot access repository path: ${err.message}` };
    }
    sanitized.repositoryRoot = resolvedPath;
  } else {
    sanitized.repositoryRoot = process.cwd();
  }

  if (args.base !== undefined) {
    if (typeof args.base !== 'string' || args.base.trim() === '') {
      return { valid: false, error: 'Parameter base must be a non-empty string.' };
    }
    const trimmedBase = args.base.trim();
    // Reject leading hyphens to prevent Git CLI option injection (e.g. --output=..., -p)
    if (trimmedBase.startsWith('-')) {
      return { valid: false, error: 'Parameter base cannot start with a hyphen (-).' };
    }
    // Reject shell control characters, command separators, and whitespace
    if (/[\s\r\n\0;&|`$><]/.test(trimmedBase)) {
      return { valid: false, error: 'Parameter base contains invalid revision characters.' };
    }
    sanitized.base = trimmedBase;
  }

  if (args.staged !== undefined) {
    if (typeof args.staged !== 'boolean') {
      return { valid: false, error: 'Parameter staged must be a boolean.' };
    }
    sanitized.staged = args.staged;
  }

  if (args.includeUntracked !== undefined) {
    if (typeof args.includeUntracked !== 'boolean') {
      return { valid: false, error: 'Parameter includeUntracked must be a boolean.' };
    }
    sanitized.includeUntracked = args.includeUntracked;
  }

  if (args.goal !== undefined) {
    if (typeof args.goal !== 'string') {
      return { valid: false, error: 'Parameter goal must be a string.' };
    }
    sanitized.goal = args.goal.trim();
  }

  if (args.diff !== undefined) {
    if (typeof args.diff !== 'string') {
      return { valid: false, error: 'Parameter diff must be a string.' };
    }
    sanitized.diff = args.diff;
  }

  return { valid: true, sanitized };
}

/**
 * Formats a runGate result into human-readable MCP tool text prefixed with ⚡ BOLT.
 *
 * @param {object} gateResult - Output from runGate
 * @returns {string} Formatted text
 */
export function formatBoltMcpOutput(gateResult) {
  const isPostImpl = Boolean(gateResult.isPostImplementation);
  const decisionBadge = isPostImpl
    ? (gateResult.verdict ||
        (gateResult.decision === 'pass'
          ? 'PASS'
          : gateResult.decision === 'pass_with_warnings'
            ? 'PASS WITH WARNINGS'
            : 'FAIL'))
    : (gateResult.decision === 'pass'
        ? 'PASS'
        : gateResult.decision === 'blocked'
          ? 'BLOCKED'
          : gateResult.decision === 'incomplete'
            ? 'INCOMPLETE'
            : 'ERROR');

  let output = `⚡ BOLT — ${isPostImpl ? 'Post-Implementation Quality Gate Report' : 'Policy Gate Report'}\n`;
  output += `============================================\n`;
  if (isPostImpl) {
    output += `Verdict:   ${decisionBadge} (Exit code: ${gateResult.exitCode})\n`;
    if (gateResult.goal) {
      output += `Goal:      ${gateResult.goal}\n`;
    } else {
      output += `Goal:      (Not provided — goal alignment unverified)\n`;
    }
  } else {
    output += `Decision:  ${decisionBadge} (Exit code: ${gateResult.exitCode})\n`;
  }
  output += `Summary:   ${gateResult.summary}\n`;

  if (Array.isArray(gateResult.findings) && gateResult.findings.length > 0) {
    if (isPostImpl) {
      output += `Violations: ${gateResult.findings.length} finding(s)\n\n`;
      for (const finding of gateResult.findings) {
        const locPath = finding.filePath || finding.location?.filePath || 'unknown_file';
        const locLine = finding.line || finding.location?.lineRange?.start || 1;
        output += `• [${finding.ruleId || finding.rule?.id || 'RULE'}] ${locPath}:${locLine}\n`;
        const title = finding.title ? `${finding.title}: ` : '';
        const expl = finding.details || finding.explanation || '';
        output += `  ${title}${expl}\n`;
        if (finding.impact) {
          output += `  Why it matters: ${finding.impact}\n`;
        }
        if (finding.nextAction) {
          output += `  Correction    : ${finding.nextAction}\n`;
        }
        if (finding.evidence) {
          const evStr = typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence);
          output += `  Evidence      : ${evStr}\n`;
        }
      }
    } else {
      output += `Violations: ${gateResult.findings.length} blocking finding(s)\n\n`;
      for (const finding of gateResult.findings) {
        output += `• [${finding.ruleId}] ${finding.filePath}:${finding.line || 1}\n`;
        output += `  ${finding.explanation}\n`;
        if (finding.evidence) {
          output += `  Evidence: ${finding.evidence}\n`;
        }
      }
    }
    output += `\n`;
  } else {
    output += `\n`;
  }

  if (gateResult.report && typeof gateResult.report === 'string') {
    output += `---\nFull Gate Output:\n${gateResult.report.trim()}\n`;
  }

  return output.trim();
}

/**
 * Creates and initializes an MCP stdio server.
 *
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.stdin] - Input stream (defaults to process.stdin)
 * @param {NodeJS.WritableStream} [options.stdout] - Output stream (defaults to process.stdout)
 * @param {NodeJS.WritableStream} [options.stderr] - Error stream (defaults to process.stderr)
 * @param {Function} [options.runGateFn] - Engine runner override (defaults to runGate)
 * @returns {{ close: Function }} Controller handle
 */
export function createMcpServer(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const runGateFn = options.runGateFn || runGate;

  const sendResponse = (msg) => {
    stdout.write(JSON.stringify(msg) + '\n');
  };

  const rl = readline.createInterface({
    input: stdin,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error: invalid JSON received by BOLT MCP server.',
        },
      });
      return;
    }

    if (typeof message !== 'object' || message === null) {
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    // Handle notifications (no response permitted)
    if (isNotification) {
      if (method === 'notifications/initialized') {
        // Client confirmed initialization; ready for requests
      }
      return;
    }

    // Handle requests
    try {
      switch (method) {
        case 'initialize': {
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: SERVER_NAME,
                version: SERVER_VERSION,
              },
            },
          });
          break;
        }

        case 'ping': {
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {},
          });
          break;
        }

        case 'tools/list': {
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOL_DEFINITIONS,
            },
          });
          break;
        }

        case 'tools/call': {
          const toolName = params && params.name;
          const toolArgs = (params && params.arguments) || {};

          if (toolName !== 'bolt_check_dependencies' && toolName !== 'bolt_post_implementation_gate') {
            sendResponse({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `⚡ BOLT — Error: Unknown tool '${toolName}'. Supported tools: bolt_check_dependencies, bolt_post_implementation_gate.`,
                  },
                ],
                isError: true,
              },
            });
            break;
          }

          const validation = validateToolArguments(toolArgs, toolName);
          if (!validation.valid) {
            sendResponse({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `⚡ BOLT — Validation Error: ${validation.error}`,
                  },
                ],
                isError: true,
              },
            });
            break;
          }

          try {
            const isPostGate = toolName === 'bolt_post_implementation_gate';
            const gateResult = await runGateFn({
              repositoryRoot: validation.sanitized.repositoryRoot,
              base: validation.sanitized.base,
              staged: validation.sanitized.staged,
              includeUntracked: validation.sanitized.includeUntracked,
              goal: validation.sanitized.goal,
              diff: validation.sanitized.diff,
              postImplementation: isPostGate,
              silent: true,
            });

            const formattedText = formatBoltMcpOutput(gateResult);
            const isExecutionFailure = isPostGate
              ? gateResult.exitCode !== EXIT_CODES.SUCCESS
              : gateResult.exitCode >= EXIT_CODES.VERIFICATION_FAILURE;

            sendResponse({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: formattedText,
                  },
                ],
                isError: isExecutionFailure,
              },
            });
          } catch (runErr) {
            sendResponse({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `⚡ BOLT — Execution Failure: ${runErr.message}`,
                  },
                ],
                isError: true,
              },
            });
          }
          break;
        }

        default: {
          sendResponse({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
          break;
        }
      }
    } catch (unhandledErr) {
      stderr.write(`[BOLT MCP Server Error] ${unhandledErr.stack || unhandledErr.message}\n`);
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Internal server error: ${unhandledErr.message}`,
        },
      });
    }
  });

  return {
    close() {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Direct Execution Entry Point
// ---------------------------------------------------------------------------
const isDirectCliInvocation = () => {
  if (!process.argv || !process.argv[1]) return false;
  try {
    const currentFilePath = path.resolve(fileURLToPath(import.meta.url));
    const invokedFilePath = path.resolve(process.argv[1]);
    return currentFilePath === invokedFilePath;
  } catch {
    return false;
  }
};

if (isDirectCliInvocation()) {
  createMcpServer();
}
