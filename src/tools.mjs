import { findBinary } from './toolrun.mjs';
import { rtkReport } from './rtk.mjs';
import { ccusageReport } from './ccusage.mjs';

const REGISTRY = [
  {
    id: 'rtk',
    binary: 'rtk',
    label: 'rtk',
    repo: 'https://github.com/rtk-ai/rtk',
    blurb: 'filters command output before it reaches the model',
    report: rtkReport,
  },
  {
    id: 'ccusage',
    binary: 'ccusage',
    label: 'ccusage',
    repo: 'https://github.com/ccusage/ccusage',
    blurb: 'reads what Claude Code actually billed, from the same transcripts',
    report: ccusageReport,
  },
];

export function detectTools(env = process.env) {
  return REGISTRY.map(({ id, label, repo, blurb, binary }) => ({
    id,
    label,
    repo,
    blurb,
    ...findBinary(binary, env),
  }));
}

export const toolById = (id) => REGISTRY.find((tool) => tool.id === id) || null;

export async function toolReport(id, target, { env = process.env } = {}) {
  const tool = toolById(id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);

  const found = findBinary(tool.binary, env);
  if (!found.found) {
    throw new Error(`${tool.label} is not installed, or not on the PATH this server was started with.`);
  }

  const report = await tool.report(target);
  return { ...report, id: tool.id, label: tool.label, repo: tool.repo, path: found.path };
}
