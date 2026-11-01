import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const host = '/home/sbtzk/.pi/agent/install/releases/1.4.0/node_modules';
const sdk = `${host}/@earendil-works/pi-coding-agent`;
const require = createRequire(`${sdk}/package.json`);
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: {
  '@earendil-works/pi-tui': `${host}/@earendil-works/pi-tui/dist/index.js`,
  '@earendil-works/pi-coding-agent': `${sdk}/dist/index.js`,
}});
const { buildTreeView, splitNotices, registerTreeResults } = await jiti.import('../tree-results.ts');
const { loadExtensions } = await import(`${sdk}/dist/core/extensions/loader.js`);
const { initTheme, getThemeByName } = await import(`${sdk}/dist/modes/interactive/theme/theme.js`);
const { visibleWidth } = await import(`${host}/@earendil-works/pi-tui/dist/index.js`);
initTheme('dark', false);
const theme = getThemeByName('dark');
const options = { icons: false, expanded: false, previewLines: 20, args: {} };
const view = (tool, text, opt = {}) => buildTreeView(tool, text, theme, {...options, ...opt});
const plain = (v) => v.lines.map(stripAnsi).join('\n');

// Pure views (no network or model requests).
test('ls connectors, directory/file distinction, spaces and dotfiles', () => {
  const v = plain(view('ls', '.git/\n数学 笔记.typ\nLICENSE\n[real file]'));
  assert.match(v, /├── \.git\//); assert.match(v, /数学 笔记.typ/); assert.match(v, /└── \[real file\]/);
});
test('find merges nested directories, correctly terminates siblings, preserves absolute paths', () => {
  const v = plain(view('find', 'src/z.ts\nsrc/deep/a.ts\nsrc/deep/b.ts\nREADME.md'));
  assert.equal(v.split('src/').length, 2);
  assert.match(v, /├── src\/\n│   ├── deep\/\n│   │   ├── a.ts\n│   │   └── b.ts\n│   └── z.ts\n└── README.md/);
  assert.match(plain(view('find', '/tmp/a\n/tmp/b')), /└── \/\n    └── tmp\//);
});
test('deep trees avoid recursion overflow', () => {
  assert.ok(view('find', Array(1500).fill('d').join('/') + '/a').lines.length <= 22);
});
test('grep groups files and preserves context, duplicates, blank match lines and line numbers', () => {
  const raw='src/a.ts-1- before\nsrc/a.ts:2: hello\nsrc/a.ts-3- after\nsrc/b.ts:5: \nsrc/a.ts:2: hello';
  const v=plain(view('grep',raw));
  assert.match(v,/3 matches · 2 files/); assert.match(v,/  1 │ before/); assert.match(v,/  2 │ hello/);
  assert.equal(v.split('src/a.ts').length,2); assert.equal(v.split('│ hello').length,3);
});
test('literal highlights, simple alternation, case-insensitivity; no unsafe regex execution', () => {
  const raw='a.ts:1: Hello foo Hello';
  const literal=view('grep',raw,{args:{pattern:'hello',literal:true,ignoreCase:true}});
  const unstyled=view('grep',raw);
  assert.notEqual(literal.lines.at(-1),unstyled.lines.at(-1));
  assert.equal(plain(literal),plain(unstyled));
  assert.notEqual(view('grep',raw,{args:{pattern:'Hello|foo'}}).lines.at(-1),unstyled.lines.at(-1));
  assert.equal(view('grep',raw,{args:{pattern:'(a+)+$'}}).lines.at(-1),unstyled.lines.at(-1));
});
test('unknown grep and ls formats fall back rather than destroy content', () => {
  assert.equal(view('grep','unrecognized json'),undefined);
  assert.equal(view('ls','src/file.ts'),undefined);
});
test('notices never become filenames; bracketed filenames survive', () => {
  const raw='a.ts\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]';
  const parsed=splitNotices(raw);
  assert.deepEqual(parsed.rows,['a.ts']); assert.equal(parsed.notices.length,1);
  const v=plain(view('find',raw,{previewLines:0}));
  assert.match(v,/more rows/); assert.match(v,/1000 results limit/); assert.doesNotMatch(v,/── \[1000/);
  assert.deepEqual(splitNotices('[real file]').rows,['[real file]']);
});
test('collapsed budget and expansion, 0 results and icons', () => {
  const raw=Array.from({length:25},(_,i)=>`f${i}.ts`).join('\n');
  assert.equal(view('ls',raw).lines.length,22);
  assert.equal(view('ls',raw,{expanded:true}).lines.length,26);
  assert.match(plain(view('ls','(empty directory)')),/0 results/);
  assert.match(plain(view('find','No files found matching pattern')),/0 results/);
  assert.match(plain(view('grep','No matches found')),/0 results/);
  assert.notEqual(plain(view('ls','a.ts',{icons:true})),plain(view('ls','a.ts')));
});

function renderer() {
  let wrapper; const sentinel={render:()=>['downstream'],invalidate(){}}; let fallbacks=0;
  const call=()=>sentinel; const shell=()=>sentinel;
  registerTreeResults({ registerToolRenderer:fn=>{wrapper=fn;}, registerCommand(){} },true,20);
  const downstream={renderCall:call,renderShell:shell,renderResult:()=>{fallbacks++;return sentinel;}};
  return {wrap:name=>wrapper(name,()=>downstream),downstream,sentinel,get fallbacks(){return fallbacks;}};
}
const result = text => ({content:[{type:'text',text}],details:{}});
const context = {isError:false,args:{},state:{},cwd:'/tmp',showImages:false};
test('renderer preserves calls/shell and unrelated tools, returns cacheable width-safe components', () => {
  const r=renderer(); assert.equal(r.wrap('bash'),r.downstream);
  const wrapped=r.wrap('ls'); assert.equal(wrapped.renderShell,r.downstream.renderShell);
  assert.equal(wrapped.renderCall,r.downstream.renderCall);
  const ctx={...context,state:{}};
  const comp=wrapped.renderResult(result('数学笔记.typ\nverylongfilename.ts'),{expanded:true,isPartial:false},theme,ctx);
  for (const width of [0,1,2,5,20,80]) {
    const rows=comp.render(width); assert.ok(rows.every(row=>visibleWidth(row)<=width), JSON.stringify({width,rows}));
    assert.equal(comp.render(width),rows);
    comp.invalidate(); assert.notEqual(comp.render(width),rows);
  }
  assert.equal(wrapped.renderResult(result('b.ts'),{expanded:true,isPartial:false},theme,ctx),comp);
  assert.match(comp.render(80).map(stripAnsi).join('\n'),/b.ts/);
});
test('errors, partial results, images and unexpected formats preserve downstream output', () => {
  const r=renderer(); const wrapped=r.wrap('grep');
  for (const [res,opt,ctx] of [
    [result('Error'),{}, {...context,isError:true}],
    [result('a.ts:1: hello'),{isPartial:true},context],
    [{content:[{type:'image',mimeType:'image/png',data:''}]},{},context],
    [result('unknown'),{},context],
  ]) assert.equal(wrapped.renderResult(res,opt,theme,ctx),r.sentinel);
  assert.equal(r.fallbacks,4);
});
test('tree-to-native error transition clears incompatible lastComponent', async () => {
  const {lsRenderers}=await import(`${sdk}/dist/core/tools/renderers/ls.js`);
  let wrapper;
  registerTreeResults({registerToolRenderer:fn=>{wrapper=fn;},registerCommand(){}},false,20);
  const r=wrapper('ls',()=>lsRenderers);
  const ctx={...context,state:{}};
  const tree=r.renderResult(result('a.ts'),{},theme,ctx);
  const native=r.renderResult(result('access denied'),{},theme,{...ctx,lastComponent:tree,isError:true});
  assert.notEqual(native,tree);
  assert.match(native.render(80).map(stripAnsi).join('\n'),/access denied/);
});
test('details-only truncation remains visible', () => {
  const wrapped=renderer().wrap('ls');
  const comp=wrapped.renderResult({...result('a.ts'),details:{entryLimitReached:1,truncation:{truncated:true}}},{},theme,{...context,state:{}});
  assert.match(comp.render(80).map(stripAnsi).join('\n'),/Truncated: 1 entries limit, byte limit reached/);
});
test('real Pi loader loads complete local Tidy extension with no tool overrides', async () => {
  const loaded=await loadExtensions([fileURLToPath(new URL('../index.ts',import.meta.url))],'/tmp');
  assert.deepEqual(loaded.errors,[]);
  assert.equal(loaded.extensions[0].tools.size,0);
  assert.ok(loaded.extensions[0].commands.has('tidy-tree'));
});
test('real built-in ls/find/grep execute against isolated files, preserving results', async () => {
  const root=mkdtempSync(join(tmpdir(),'tidy-tree-tools-'));
  try {
    mkdirSync(join(root,'src'));writeFileSync(join(root,'src','数学.ts'),'before\nhello world\nafter\n');
    writeFileSync(join(root,'README.md'),'hello\n');
    const {createLsTool,createFindTool,createGrepTool}=await import(`${sdk}/dist/index.js`);
    for (const [name,tool,args] of [
      ['ls',createLsTool(root),{path:'.',limit:1}],
      ['find',createFindTool(root),{pattern:'**/*'}],
      ['grep',createGrepTool(root),{pattern:'hello',context:1}],
    ]) {
      const res=await tool.execute('fixture',args);
      const before=JSON.stringify(res);
      const text=res.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
      const v=view(name,text,{args});assert.ok(v,`${name}: ${text}`);
      assert.equal(JSON.stringify(res),before);
      if(name==='grep'){assert.match(plain(v),/hello world/);assert.match(plain(v),/before/);}
      if(name==='ls')assert.match(plain(v),/entries limit/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
