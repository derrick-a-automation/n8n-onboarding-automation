#!/usr/bin/env node
/*
 * Offline simulator for the onboarding workflow.
 *
 * Runs every Code node's real JavaScript and emulates the Webhook, Set, IF, Gmail and
 * Respond to Webhook nodes, following the workflow's own connections. No n8n instance,
 * credentials or network needed.
 *
 * Usage:  node tests/simulate.js [path/to/workflow.json]
 * Exit code is non-zero if any check fails.
 *
 * Emulation notes (where this differs from real n8n):
 *  - Gmail nodes record the message and output a stub send result, as real Gmail does
 *    (the original item is replaced).
 *  - IF nodes support the two operators this workflow uses: string equals, boolean true.
 *  - $('Node').first() / .all() / .item read the referenced node's latest output.
 */
const fs = require('fs');
const path = require('path');

const wfPath = process.argv[2] || path.join(__dirname, '..', 'workflows', 'onboard-automation.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// ------------------------------------------------------------------ structure
console.log(`\nWorkflow: ${wf.name} (${wf.nodes.length} nodes)`);
console.log('\n[structure]');
const missing = [];
for (const [src, c] of Object.entries(wf.connections)) {
  if (!byName[src]) missing.push(src);
  for (const out of c.main) for (const t of out || []) if (!byName[t.node]) missing.push(t.node);
}
check(missing.length === 0, `all connections point at existing nodes${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
const paths = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook')
  .map((n) => `${n.parameters.httpMethod || 'GET'} ${n.parameters.path}`);
check(new Set(paths).size === paths.length, 'webhook method+path pairs are unique');
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
  let ok = true;
  try { new Function('$input', '$', n.parameters.jsCode); } catch (e) { ok = false; }
  check(ok, `code node parses: ${n.name}`);
}

// ------------------------------------------------------------------ engine
function evalExpr(str, ctx) {
  if (typeof str !== 'string' || !str.startsWith('=')) return str;
  const body = str.slice(1);
  const $now = { toISO: () => new Date().toISOString() };
  const run = (code) => new Function('$json', '$', '$now', `return (${code});`)(ctx.json, ctx.$, $now);
  const whole = body.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (_, c) => { const v = run(c); return v === undefined ? '' : String(v); });
}

function run(startNode, items) {
  const outputs = {};
  const sent = [];
  let response = null;
  const $ = (name) => {
    if (!outputs[name]) throw new Error(`$('${name}') referenced before it ran`);
    return { first: () => outputs[name][0], all: () => outputs[name], item: outputs[name][0] };
  };
  const queue = [[startNode, items]];
  while (queue.length) {
    const [name, input] = queue.shift();
    const n = byName[name];
    if (!n) throw new Error(`no node named ${name}`);
    let out = input;
    let branches = null;
    switch (n.type) {
      case 'n8n-nodes-base.webhook':
        break;
      case 'n8n-nodes-base.code': {
        const fn = new Function('$input', '$', n.parameters.jsCode);
        out = fn({ all: () => input, first: () => input[0], item: input[0] }, $).map((i) => (i.json ? i : { json: i }));
        break;
      }
      case 'n8n-nodes-base.set':
        out = input.map((it) => {
          const ctx = { json: it.json, $ };
          if (n.parameters.mode === 'raw') return { json: evalExpr(n.parameters.jsonOutput, ctx) };
          const base = n.parameters.includeOtherFields ? { ...it.json } : {};
          for (const a of n.parameters.assignments.assignments) base[a.name] = evalExpr(a.value, ctx);
          return { json: base };
        });
        break;
      case 'n8n-nodes-base.if': {
        const cond = n.parameters.conditions.conditions[0];
        const t = []; const f = [];
        for (const it of input) {
          const v = evalExpr(cond.leftValue, { json: it.json, $ });
          const ok = cond.operator.operation === 'equals' ? v === cond.rightValue : v === true;
          (ok ? t : f).push(it);
        }
        branches = [t, f];
        break;
      }
      case 'n8n-nodes-base.gmail':
        out = input.map((it) => {
          const ctx = { json: it.json, $ };
          sent.push({
            node: name,
            to: evalExpr(n.parameters.sendTo, ctx),
            subject: evalExpr(n.parameters.subject, ctx),
            message: evalExpr(n.parameters.message, ctx),
          });
          return { json: { id: 'stub-message-id', labelIds: ['SENT'] } };
        });
        break;
      case 'n8n-nodes-base.respondToWebhook':
        response = evalExpr(n.parameters.responseBody, { json: input[0].json, $ });
        break;
      default:
        throw new Error(`simulator does not handle node type ${n.type} (${name})`);
    }
    outputs[name] = out;
    (wf.connections[name]?.main || []).forEach((targets, idx) => {
      const data = branches ? branches[idx] : out;
      if (data && data.length) for (const t of targets || []) queue.push([t.node, data]);
    });
  }
  return { outputs, sent, response };
}

// ------------------------------------------------------------------ helpers
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/type="hidden" name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
const noBlanks = (mails) => mails.every((m) => !/undefined|\[object Object\]/.test(m.subject + m.message) && m.to);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// ------------------------------------------------------------------ scenarios
function hrToForm(payloadFile, expectType) {
  const payload = fixture(payloadFile);
  const r = run('HR System Listener (Webhook)', [{ json: { headers: {}, body: payload } }]);
  const body = r.outputs['Enrich Payload'][0].json.body;
  check(/^ONB-[A-Z0-9]{6}-\d{8}-\d{6}$/.test(body.onbId), `onbId generated (${body.onbId})`);
  check(body.employmentType === expectType, `employmentType normalized to ${expectType}`);
  const mgr = r.sent.find((m) => m.node.endsWith('to Mgr'));
  check(Boolean(mgr) && mgr.to === payload.managerEmail, 'manager notification sent to managerEmail');
  check(Boolean(mgr) && mgr.message.includes(body.formUrl), 'manager email contains the form link');
  check(noBlanks(r.sent), 'no blank or undefined values in emails');

  const url = new URL(body.formUrl);
  const formNode = url.pathname.includes('contr-') ? 'Present ONB Form - Contractor' : 'Present ONB Form - FTE';
  const g = run(formNode, [{ json: { query: Object.fromEntries(url.searchParams) } }]);
  const hidden = hiddenFields(g.response);
  check(['onbId', 'fn', 'ln', 'sd', 'me', 'ee', 'et'].every((k) => k in hidden), 'form carries all 7 hidden fields');
  check(hidden.ln === payload.lastName, `special characters survive the round trip (${hidden.ln})`);
  check(/name="monitor"/.test(g.response) && /name="dock"/.test(g.response), 'form shows Monitor and Dock checkboxes');
  return { hidden, submitNode: formNode.includes('Contractor') ? 'FWD Contr ONB Form' : 'FWD FTE ONB Form' };
}

function submit(submitNode, hidden, answers) {
  return run(submitNode, [{ json: { body: { ...hidden, ...answers } } }]);
}

console.log('\n[FTE: HR trigger -> manager form]');
const fte = hrToForm('newhire-fte.json', 'FTE');

console.log('\n[FTE: full provisioning submit]');
{
  const r = submit(fte.submitNode, fte.hidden, {
    hardware: 'Standard Engineering Laptop', monitor: 'Monitor', dock: 'Dock',
    software: 'Office 365, Slack, Adobe Creative Cloud', network: 'VPN, Shared Drive A, Admin VLAN',
    instructions: 'Ship to <home> address & call first',
  });
  const g = r.outputs['Gather Provision Info'][0].json;
  check(g.needsLaptop && g.needsMonitor && g.needsDock, 'laptop, monitor and dock flags set');
  check(/Submission received/.test(r.response), 'manager gets the acknowledgement page');
  const teams = r.sent.filter((m) => m.node === 'Notify Provisioning Team').map((m) => m.to.match(/\+(\w+)@/)[1]).sort();
  check(teams.join() === 'facilities,hardware,network,software', `one email per team with work (${teams.join(', ')})`);
  const hw = r.sent.find((m) => m.to.includes('+hardware'));
  check(hw && (hw.message.match(/SCTASK\d+/g) || []).length === 3, 'hardware email lists 3 SCTasks');
  check(r.sent.every((m) => !/<home>/.test(m.message)), 'form text is HTML-escaped in emails');
  const f = r.outputs['Unified Onboarding Summary'][0].json;
  check(f.provisioning.tasksGenerated === 10 && f.provisioning.ritms.length === 4, `summary: ${f.provisioning.tasksGenerated} tasks, ${f.provisioning.ritms.length} RITMs`);
  check(f.onboardingId === fte.hidden.onbId && f.manager.email === fte.hidden.me, 'summary keeps onbId and manager');
  check(noBlanks(r.sent), 'no blank or undefined values in emails');
}

console.log('\n[Contractor: HR trigger -> manager form]');
const con = hrToForm('newhire-contractor.json', 'Contractor');

console.log('\n[Contractor: laptop + access submit]');
{
  const r = submit(con.submitNode, con.hidden, {
    hardware: 'Standard Corporate Laptop', software: 'Slack, Jira', network: 'Contractor VPN', instructions: 'Creds expire 2027-03-31',
  });
  const f = r.outputs['Unified Onboarding Summary'][0].json;
  check(f.employee.classification === 'Contractor', 'classification is Contractor');
  check(f.provisioning.required === true && f.provisioning.sctasks.length === 4, `${f.provisioning.sctasks.length} SCTasks created`);
  check(noBlanks(r.sent), 'no blank or undefined values in emails');
}

console.log('\n[Contractor: BYOD, nothing requested -> no-provision path]');
{
  const r = submit(con.submitNode, con.hidden, {
    hardware: 'No Hardware - Bring Your Own Device (BYOD)', software: '', network: '', instructions: '',
  });
  const f = r.outputs['Unified Onboarding Summary'][0].json;
  check(f.provisioning.required === false && f.provisioning.tasksGenerated === 0, 'no provisioning required');
  check(r.sent.map((m) => m.node).join() === 'Notify Manager (No Tasks),Notify HR - No Tasks', 'manager and HR notified');
  check(noBlanks(r.sent), 'no blank or undefined values in emails');
}

console.log('\n[Form link without onbId]');
{
  const r = run('Present ONB Form - FTE', [{ json: { query: {} } }]);
  check(/Link incomplete/.test(r.response), 'shows the "Link incomplete" page');
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
