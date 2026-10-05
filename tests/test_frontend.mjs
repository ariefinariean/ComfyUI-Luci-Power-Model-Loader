import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "..", "web", "power_model_loader.js");
const source = fs
  .readFileSync(sourcePath, "utf8")
  .replace(/^import\s+\{\s*app\s*\}.*?;\s*/m, "");

let extension;
const app = {
  registerExtension(value) {
    extension = value;
  },
};

let lastInput = null;
let lastContextMenu = null;
class FakeContextMenu {
  constructor(items, options) {
    lastContextMenu = { items, options };
  }
}

const document = {
  body: {
    appendChild(element) {
      lastInput = element;
    },
  },
  createElement(tag) {
    assert.equal(tag, "input");
    const listeners = new Map();
    return {
      style: {},
      value: "",
      removed: false,
      setAttribute() {},
      addEventListener(name, callback) { listeners.set(name, callback); },
      focus() {},
      select() {},
      remove() { this.removed = true; },
      emit(name, event = {}) { listeners.get(name)?.(event); },
    };
  },
};

const context = vm.createContext({
  app,
  console,
  document,
  LiteGraph: { ContextMenu: FakeContextMenu },
  window: {
    alert() {},
    LiteGraph: { ContextMenu: FakeContextMenu },
  },
});
vm.runInContext(source, context, { filename: sourcePath });
assert.ok(extension, "frontend extension should register");

class FakeNode {
  constructor() {
    this.properties = {};
    this.size = [300, 300];
    this.pos = [100, 200];
    this.widgets = [
      { name: "active_group", value: 1 },
      {
        name: "group_config",
        value: '{"version":1,"groups":[{"id":1,"name":"BF16"}]}',
      },
    ];
    this.inputs = [
      { name: "group_01_model", type: "MODEL", link: 1 },
      { name: "group_01_clip", type: "CLIP", link: 2 },
      { name: "group_01_vae", type: "VAE", link: 3 },
    ];
    this.outputs = [{ name: "model" }, { name: "clip" }, { name: "vae" }];

    const sourceNode = {
      title: "Qwen loader",
      widgets: [
        { name: "unet_name", value: "Qwen/qwen_image_2.1_bf16.safetensors" },
        { name: "clip_name", value: "qwen3vl_8b_bf16.safetensors" },
        { name: "vae_name", value: "qwen_image_2.1_vae_bf16.safetensors" },
      ],
    };
    this.graph = {
      links: {
        1: { origin_id: 50 },
        2: { origin_id: 50 },
        3: { origin_id: 50 },
      },
      getNodeById(id) {
        return Number(id) === 50 ? sourceNode : null;
      },
    };
  }

  addInput(name, type) {
    this.inputs.push({ name, type, link: null });
  }

  removeInput(index) {
    this.inputs.splice(index, 1);
  }

  addWidget(type, name, value, callback, options = {}) {
    const widget = { type, name, value, callback, options, y: 0 };
    this.widgets.push(widget);
    return widget;
  }

  setSize(size) {
    this.size = size;
  }

  setDirtyCanvas() {}
}

await extension.beforeRegisterNodeDef(FakeNode, { name: "PowerModelLoader" });
const node = new FakeNode();
node.onNodeCreated();

const drawCalls = [];
const ctx = {
  save() {},
  restore() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  quadraticCurveTo() {},
  closePath() {},
  fill() { drawCalls.push("fill"); },
  stroke() { drawCalls.push("stroke"); },
  fillText(value) { drawCalls.push(String(value)); },
  measureText(value) { return { width: String(value).length * 6 }; },
};

node.onDrawBackground(ctx);
node.onDrawForeground(ctx);

assert.match(node.inputs[0].__luciFilename, /qwen_image_2\.1_bf16\.safetensors/);
assert.match(node.inputs[1].__luciFilename, /qwen3vl_8b_bf16\.safetensors/);
assert.match(node.inputs[2].__luciFilename, /qwen_image_2\.1_vae_bf16\.safetensors/);
assert.ok(drawCalls.includes('1 connected / 1 groups'));
assert.equal(node.outputs[0].pos[1],20);
assert.equal(node.outputs[2].pos[1],68);
assert.equal(node.getConnectionPos(false, 2)[1],268);
assert.ok(drawCalls.includes("BF16"), "group card should draw its name");
assert.ok(drawCalls.includes("SELECTED"), "selected group badge should draw");
assert.ok(drawCalls.includes("fill") && drawCalls.includes("stroke"), "group cards should render");
assert.deepEqual(node.inputs[0].pos.length, 2, "input slots should receive card positions");
assert.equal(node.size[0],420, "default width should be compact");
assert.ok(drawCalls.includes('+ Add group'), 'custom action should be drawn');
node.size = [320,1400];
node.onResize(node.size);
assert.equal(node.size[0],320, 'user can shrink the node');
assert.equal(node.outputs[0].pos[0],320);

node.onDblClick(
  { clientX: 124, clientY: 172, preventDefault() {}, stopPropagation() {} },
  [24, 142],
  { ds: { scale: 1 } },
);
assert.ok(lastInput, "double-clicking should open an inline name editor");
assert.equal(lastInput.value, "BF16");
lastInput.value = "Renamed BF16";
lastInput.emit("keydown", { key: "Enter", preventDefault() {} });
assert.match(
  node.widgets.find((widget) => widget.name === "group_config").value,
  /Renamed BF16/,
  "double-clicking a card header should rename that group",
);

node.size = [720, 1400];
node.onResize(node.size);
assert.equal(node.size[0], 720, "the resized width should be retained");
assert.ok(node.size[1] < 700, "vertical resize should snap back to the content height");
assert.equal(node.outputs[0].pos[0], 720, "outputs should follow the current node width");
assert.equal(node.computeSize()[0],320,'resize minimum must not grow with current width');
// Model the canvas resize handler: it clamps a drag target to computeSize().
for (const requestedWidth of [1600, 900, 420, 320]) {
  node.size = [Math.max(requestedWidth, node.computeSize()[0]), node.size[1]];
  node.onResize(node.size);
  assert.equal(node.size[0],requestedWidth,'canvas should allow shrinking after growth');
  assert.equal(node.outputs[0].pos[0],requestedWidth);
}

const addButton = node.widgets.find((widget) => widget.name === "Add input group");
assert.ok(addButton, "add-group control should exist");
addButton.callback();
assert.equal(node.inputs.length, 6, "adding a group should add one complete triplet");
assert.equal(node.widgets.find((widget) => widget.name === "active_group").value, 1,
  "adding an empty group must preserve the active selection");
assert.equal(
  node.widgets.some((widget) => widget.name === "Use model group"),
  false,
  "group cards should replace the redundant selector",
);
assert.equal(
  node.widgets.some((widget) => widget.name === "Rename selected group"),
  false,
  "the redundant rename button should not exist",
);
assert.equal(
  node.widgets.some((widget) => widget.name === "Remove selected group"),
  false,
  "group deletion should live in the group context menu",
);

node.onMouseDown({ button: 0 }, [40, 145], null);
assert.equal(
  node.widgets.find((widget) => widget.name === "active_group").value,
  1,
  "clicking a group card should select it",
);

node.onMouseDown(
  { button: 2, clientX: 140, clientY: 280, preventDefault() {}, stopPropagation() {} },
  [40, 285],
  { ds: { scale: 1 } },
);
assert.ok(lastContextMenu, "right-clicking a group header should open its menu");
assert.equal(
  lastContextMenu.items.filter(Boolean).map((item) => item.content).join("|"),
  "Rename group|Use connected title|Delete group",
);
lastContextMenu.items.find((item) => item?.content === "Delete group").callback();
assert.equal(node.inputs.length, 3, "deleting a group should remove its complete triplet");

node.onMouseDown(
  {button:2,preventDefault(){},stopPropagation(){}}, [40,145], null,
);
lastContextMenu.items.find(item=>item?.content==='Use connected title').callback();
drawCalls.length=0;
node.onDrawForeground(ctx);
assert.ok(drawCalls.includes('Qwen loader'), 'automatic title should use the upstream source');
node.graph.getNodeById(50).title='Renamed source subgraph';
drawCalls.length=0;
node.onDrawForeground(ctx);
assert.ok(drawCalls.includes('Renamed source subgraph'), 'title should follow upstream renames');
node.inputs[2].link=null;
drawCalls.length=0;
node.onDrawForeground(ctx);
assert.ok(drawCalls.includes('2/3'));
assert.ok(drawCalls.includes('0 connected / 1 groups'));

addButton.callback();
const menuOptions=[];
const returnedOptions=node.getExtraMenuOptions({graph_mouse:[140,405]});
assert.ok(returnedOptions.some(item=>item?.content==='Delete this group'),
  'menu actions must be returned when no options array is supplied');
// Native right-click path, with no preceding onMouseDown, targets the first
// card even though the second card is active.
node.getExtraMenuOptions({graph_mouse:[140,405]},menuOptions);
assert.match(menuOptions[0].content,/This group: Renamed source subgraph/);
menuOptions.find(item=>item?.content==='Delete this group').callback();
assert.equal(node.inputs.length,3);
assert.equal(node.inputs[0].name,'group_02_model','delete only the card under the cursor');
assert.equal(node.widgets.find(w=>w.name==='active_group').value,2);

// Regression: visible cables from bypassed loaders inside a subgraph used
// to disappear during graphToPrompt. Restore only the selected output paths.
const queueNode = new FakeNode();
queueNode.onNodeCreated();
const innerLoaders = ['UNETLoader', 'CLIPLoader', 'VAELoader'].map((type, id) => ({
  id, type, mode: 4, changeMode(value) { this.mode = value; },
}));
const unrelated = { type: 'KSampler', mode: 4 };
const unselected = { type: 'UNETLoader', mode: 4 };
const subgroup = {
  type: 'test-subgroup', title: 'Bypassed group', mode: 0,
  subgraph: {
    _nodes: [...innerLoaders, unrelated],
    outputs: innerLoaders.map((_, id) => ({ linkIds: [100 + id] })),
    links: Object.fromEntries(innerLoaders.map((_, id) =>
      [100 + id, { origin_id: id, origin_slot: 0 }])),
    getNodeById(id) { return innerLoaders[id]; },
  },
};
queueNode.graph = {
  links: Object.fromEntries([1, 2, 3].map((id, slot) =>
    [id, { origin_id: 50, origin_slot: slot }])),
  getNodeById(id) { return id === 50 ? subgroup : unselected; },
};
queueNode.widgets.find(w => w.name === 'Add input group').callback();
queueNode.graph.links[4] = { origin_id: 60, origin_slot: 0 };
queueNode.inputs.find(i => i.name === 'group_02_model').link = 4;
drawCalls.length = 0;
queueNode.onDrawForeground(ctx);
assert.ok(drawCalls.includes('Bypassed loaders · restored when queued'));
queueNode.widgets.find(w => w.name === 'active_group').beforeQueued();
assert.deepEqual(innerLoaders.map(n => n.mode), [0, 0, 0]);
assert.equal(unrelated.mode, 4, 'unrelated processors must remain unchanged');
assert.equal(unselected.mode, 4, 'unselected loader must remain unchanged');
innerLoaders[0].mode = 2;
queueNode.widgets.find(w => w.name === 'active_group').beforeQueued();
assert.equal(innerLoaders[0].mode, 2, 'Never/muted nodes must not be enabled');

console.log("frontend UI and bypass regression tests OK");
