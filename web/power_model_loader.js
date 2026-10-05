import { app } from "../../scripts/app.js";

const NODE_NAME = "PowerModelLoader";
const MAX_GROUPS = 16;
const MIN_NODE_WIDTH = 320;
const DEFAULT_NODE_WIDTH = 420;
const CARD_TOP = 130;
const CARD_HEIGHT = 132;
const CARD_GAP = 10;
const CARD_HEADER_HEIGHT = 53;
const SLOT_FIRST_OFFSET = 72;
const SLOT_ROW_HEIGHT = 24;
const KINDS = [
  ["model", "MODEL"],
  ["clip", "CLIP"],
  ["vae", "VAE"],
];

const luciNodes = new Set();
let luciMenu = null;
function closeLuciMenu() { luciMenu?.remove(); luciMenu = null; }
// Handle the native DOM event before ComfyUI/other extensions replace node
// menu hooks. This also avoids relying on a globally exported LiteGraph.
if (typeof document.addEventListener === 'function') {
  document.addEventListener('contextmenu', event => {
    const canvas = app.canvas;
    const element = canvas?.canvas;
    if (!element || event.target !== element) return;
    const rect = element.getBoundingClientRect();
    const scale = canvas.ds?.scale || 1;
    const offset = canvas.ds?.offset || [0,0];
    const point = [(event.clientX - rect.left) / scale - offset[0],
      (event.clientY - rect.top) / scale - offset[1]];
    const graph = canvas.graph ?? app.graph;
    const hitNode = graph?.getNodeOnPos?.(point[0], point[1]);
    const candidates = hitNode ? [hitNode] : [...luciNodes].reverse();
    for (const node of candidates) {
      if (!luciNodes.has(node) || node.graph !== graph || node.flags?.collapsed) continue;
      const local = [point[0] - node.pos[0], point[1] - node.pos[1]];
      if (node.__luciOpenGroupMenu?.(event, local, canvas)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    if (luciMenu && !luciMenu.contains(event.target)) closeLuciMenu();
  }, true);
  document.addEventListener('keydown', event => { if(event.key === 'Escape') closeLuciMenu(); }, true);
}

const WIDGET_PATTERNS = {
  model: [
    /^unet_name$/i,
    /^ckpt_name$/i,
    /^diffusion_model(_name)?$/i,
    /^model_name$/i,
  ],
  clip: [
    /^clip_name\d*$/i,
    /^text_encoder(_name)?\d*$/i,
    /^encoder_name\d*$/i,
  ],
  vae: [
    /^vae_name$/i,
    /^vae_model(_name)?$/i,
  ],
};

function defaultState() {
  return {
    version: 1,
    groups: [{ id: 1, name: "Group 1" }],
    activeGroup: 1,
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : defaultState();
  const used = new Set();
  const groups = [];

  for (const candidate of Array.isArray(source.groups) ? source.groups : []) {
    const id = Number(candidate?.id);
    if (!Number.isInteger(id) || id < 1 || id > MAX_GROUPS || used.has(id)) continue;
    used.add(id);
    groups.push({
      id,
      name: String(candidate?.name || `Group ${id}`).trim() || `Group ${id}`,
      autoTitle: candidate?.autoTitle ?? /^Group \d+$/.test(String(candidate?.name || `Group ${id}`)),
    });
  }

  if (!groups.length) groups.push({ id: 1, name: "Group 1" });
  groups.sort((a, b) => a.id - b.id);

  const requestedActive = Number(source.activeGroup);
  const activeGroup = groups.some((group) => group.id === requestedActive)
    ? requestedActive
    : groups[0].id;

  return { version: 1, groups, activeGroup };
}

function parseStoredState(node) {
  const propertyState = node.properties?.powerModelLoader;
  if (propertyState) return normalizeState(propertyState);

  const configWidget = node.widgets?.find((widget) => widget.name === "group_config");
  if (configWidget?.value) {
    try {
      const config = JSON.parse(configWidget.value);
      const activeWidget = node.widgets?.find((widget) => widget.name === "active_group");
      return normalizeState({ ...config, activeGroup: activeWidget?.value });
    } catch (_error) {
      // Fall through to the safe default.
    }
  }
  return defaultState();
}

function hideBackingWidget(widget) {
  if (!widget) return;
  widget.computeSize = () => [0, -4];
  widget.hidden = true;
}

function inputName(groupId, kind) {
  return `group_${String(groupId).padStart(2, "0")}_${kind}`;
}

function isPowerModelInput(name) {
  return /^group_(0[1-9]|1[0-6])_(model|clip|vae)$/.test(String(name || ""));
}

function linkFromGraph(graph, linkId) {
  if (linkId == null || !graph) return null;
  return graph.links?.get?.(linkId) ?? graph.links?.[linkId] ?? graph._links?.get?.(linkId) ?? null;
}

function sourceNodeForInput(node, input) {
  const graph = node.graph ?? app.graph ?? app.canvas?.graph;
  const link = linkFromGraph(graph, input?.link);
  if (!link) return null;
  const originId = link.origin_id ?? link.originId;
  return graph?.getNodeById?.(originId) ?? graph?.getNodeById?.(String(originId)) ?? null;
}

const MODEL_LOADER_TYPES = new Set([
  'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader',
  'VAELoader', 'CheckpointLoaderSimple', 'CheckpointLoader',
]);

// Follow the actual output path, not every node in a subgraph. In particular,
// never enable unrelated processors or branches merely because they are nearby.
function upstreamLoaders(node, input) {
  const graph = node.graph ?? app.graph;
  const link = linkFromGraph(graph, input?.link);
  const source = sourceNodeForInput(node, input);
  const found = new Set();
  const visited = new Set();
  const visit = (current, slot) => {
    if (!current || visited.has(current)) return;
    visited.add(current);
    if (MODEL_LOADER_TYPES.has(current.comfyClass ?? current.type)) {
      found.add(current);
      return;
    }
    if (!current.subgraph) return;
    found.add(current);
    const resolved = current.resolveSubgraphOutputLink?.(slot);
    if (resolved?.outputNode) {
      visit(resolved.outputNode, resolved.link?.origin_slot ?? 0);
      return;
    }
    const output = current.subgraph.outputs?.[slot];
    for (const id of output?.linkIds ?? []) {
      const innerLink = linkFromGraph(current.subgraph, id);
      const innerNode = current.subgraph.getNodeById?.(innerLink?.origin_id);
      visit(innerNode, innerLink?.origin_slot ?? 0);
    }
  };
  visit(source, link?.origin_slot ?? 0);
  return [...found];
}

function cleanWidgetValue(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    const values = value.map(cleanWidgetValue).filter(Boolean);
    return values.length ? values.join(" + ") : null;
  }
  if (typeof value === "object") {
    const nested = value.filename ?? value.name ?? value.value;
    return nested == null ? null : cleanWidgetValue(nested);
  }
  return String(value);
}

function connectedModelName(node, input, kind) {
  const source = sourceNodeForInput(node, input);
  if (!source) return "not connected";

  const widgets = Array.isArray(source.widgets) ? [...source.widgets] : [];
  const inner = source.subgraph;
  for (const child of inner?._nodes ?? inner?.nodes ?? []) {
    if (Array.isArray(child.widgets)) widgets.push(...child.widgets);
  }
  const patterns = WIDGET_PATTERNS[kind] ?? [];
  const values = [];

  for (const pattern of patterns) {
    for (const widget of widgets) {
      const widgetName = String(widget?.name ?? widget?.label ?? "");
      if (!pattern.test(widgetName)) continue;
      const value = cleanWidgetValue(widget?.value);
      if (value && !values.includes(value)) values.push(value);
    }
    if (values.length) break;
  }

  if (values.length) return values.join(" + ");
  return `${source.title || source.type || "connected source"}`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fitText(ctx, value, width) {
  let text = String(value);
  if (ctx.measureText(text).width <= width) return text;
  while (text.length && ctx.measureText(text + '…').width > width) text = text.slice(0, -1);
  return text + '…';
}

function installPowerModelUi(node) {
  luciNodes.add(node);
  node.properties ??= {};
  let state = parseStoredState(node);

  const activeBacking = node.widgets?.find((widget) => widget.name === "active_group");
  const configBacking = node.widgets?.find((widget) => widget.name === "group_config");
  hideBackingWidget(activeBacking);
  hideBackingWidget(configBacking);

  let addWidget;
  let applyingLayout = false;
  let renameEditor = null;
  if (['👻 Power Model Loader', 'Power Model Loader', '👻 Luci Model Loader'].includes(node.title)) node.title = '👻 Luci Model Loader';
  node.color = '#202020';
  node.bgcolor = '#282828';
  node.size[0] = DEFAULT_NODE_WIDTH;
  const groupTitle = (group) => {
    if (group.autoTitle === false) return group.name;
    const input = node.inputs?.find(i => i.name === inputName(group.id, 'model'));
    return sourceNodeForInput(node, input)?.title || group.name;
  };
  const connectionCount = group => KINDS.filter(([kind]) =>
    node.inputs?.find(i => i.name === inputName(group.id, kind))?.link != null).length;
  const bypassedSources = group => KINDS.some(([kind]) => {
    const input = node.inputs?.find(i => i.name === inputName(group.id, kind));
    return upstreamLoaders(node, input).some(source => source.mode === 4);
  });

  // ComfyUI invokes this hook before graphToPrompt flattens subgraphs. A
  // bypassed loader has no compatible MODEL/CLIP/VAE input to pass through,
  // so its output would otherwise be discarded before Python ever sees it.
  if (activeBacking) {
    const previousBeforeQueued = activeBacking.beforeQueued;
    activeBacking.beforeQueued = function (...args) {
      previousBeforeQueued?.apply(this, args);
      for (const [kind] of KINDS) {
        const input = node.inputs?.find(i => i.name === inputName(state.activeGroup, kind));
        for (const source of upstreamLoaders(node, input)) {
          if (source.mode !== 4) continue;
          if (typeof source.changeMode === 'function') source.changeMode(0);
          else source.mode = 0;
        }
      }
      node.setDirtyCanvas(true, true);
    };
  }

  const persist = () => {
    state = normalizeState(state);
    node.properties.powerModelLoader = JSON.parse(JSON.stringify(state));
    if (activeBacking) activeBacking.value = state.activeGroup;
    if (configBacking) {
      configBacking.value = JSON.stringify({ version: 1, groups: state.groups });
    }
  };

  const refreshInputs = () => {
    for (const group of state.groups) {
      for (const [kind, type] of KINDS) {
        const name = inputName(group.id, kind);
        let input = node.inputs?.find((candidate) => candidate.name === name);
        if (!input) {
          node.addInput(name, type);
          input = node.inputs?.find((candidate) => candidate.name === name);
        }
        if (input) input.powerModelLoader = true;
      }
    }

    const validNames = new Set(
      state.groups.flatMap((group) => KINDS.map(([kind]) => inputName(group.id, kind))),
    );
    for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
      const input = node.inputs[index];
      if (isPowerModelInput(input?.name) && !validNames.has(input.name)) node.removeInput(index);
    }
  };

  const cardY = (groupIndex) => CARD_TOP + groupIndex * (CARD_HEIGHT + CARD_GAP);

  const applyLayout = () => {
    const cardsBottom = CARD_TOP + state.groups.length * CARD_HEIGHT
      + Math.max(0, state.groups.length - 1) * CARD_GAP;
    const outputTop = 0;
    const controlsTop = cardsBottom + 16;
    const nodeHeight = controlsTop + 42;
    const width = Math.max(Number(node.size?.[0]) || 0, MIN_NODE_WIDTH);

    if (addWidget) addWidget.y = controlsTop;

    state.groups.forEach((group, groupIndex) => {
      KINDS.forEach(([kind], kindIndex) => {
        const input = node.inputs?.find((candidate) => candidate.name === inputName(group.id, kind));
        if (input) input.pos = [0, cardY(groupIndex) + SLOT_FIRST_OFFSET + kindIndex * SLOT_ROW_HEIGHT];
      });
    });

    node.outputs?.forEach((output, index) => {
      output.pos = [width, 20 + index * 24];
      output.label = ' ';
    });

    applyingLayout = true;
    node.setSize([width, nodeHeight]);
    applyingLayout = false;
    node.__powerModelLayout = { cardsBottom, controlsTop, outputTop, width, nodeHeight };
  };

  const refreshLiveNames = () => {
    for (const group of state.groups) {
      for (const [kind, type] of KINDS) {
        const input = node.inputs?.find((candidate) => candidate.name === inputName(group.id, kind));
        if (!input) continue;
        const filename = connectedModelName(node, input, kind);
        input.label = ' ';
        input.__luciFilename = filename;
      }
    }
  };

  const refresh = () => {
    persist();
    refreshInputs();
    refreshLiveNames();
    applyLayout();
    node.setDirtyCanvas(true, true);
  };

  addWidget = node.addWidget("button", "Add input group", null, () => {
    if (state.groups.length >= MAX_GROUPS) {
      window.alert(`Luci Model Loader supports up to ${MAX_GROUPS} groups.`);
      return;
    }
    const used = new Set(state.groups.map((group) => group.id));
    let id = 1;
    while (used.has(id) && id <= MAX_GROUPS) id += 1;
    state.groups.push({ id, name: `Group ${id}` });
    refresh();
  });
  // Draw the action ourselves: stock widgets are repositioned by LiteGraph
  // according to input count, which can overlap the last group card.
  hideBackingWidget(addWidget);

  const removeGroup = (group) => {
    if (state.groups.length === 1) {
      window.alert("Luci Model Loader must keep at least one group.");
      return;
    }
    const removedIndex = state.groups.findIndex((candidate) => candidate.id === group.id);
    if (removedIndex < 0) return;
    state.groups = state.groups.filter((candidate) => candidate.id !== group.id);
    if (state.activeGroup === group.id) {
      state.activeGroup = state.groups[Math.min(removedIndex, state.groups.length - 1)].id;
    }
    refresh();
  };

  const finishRename = (commit) => {
    if (!renameEditor) return;
    const { input, group } = renameEditor;
    renameEditor = null;
    const nextName = input.value.trim();
    input.remove();
    if (!commit || !nextName || nextName === group.name) return;
    if (state.groups.some((candidate) => candidate.id !== group.id && candidate.name === nextName)) {
      window.alert("Group names must be unique.");
      return;
    }
    group.name = nextName;
    group.autoTitle = false;
    refresh();
  };

  const startInlineRename = (group, event, pos, canvas) => {
    finishRename(true);
    const input = document.createElement("input");
    const scale = Number(canvas?.ds?.scale ?? app.canvas?.ds?.scale) || 1;
    const groupIndex = state.groups.findIndex((candidate) => candidate.id === group.id);
    const originX = Number(event?.clientX ?? 0) - Number(pos?.[0] ?? 0) * scale;
    const originY = Number(event?.clientY ?? 0) - Number(pos?.[1] ?? 0) * scale;

    input.type = "text";
    input.value = groupTitle(group);
    input.setAttribute("aria-label", "Group name");
    Object.assign(input.style, {
      position: "fixed",
      left: `${originX + 10 * scale}px`,
      top: `${originY + (cardY(groupIndex) + 3) * scale}px`,
      width: `${Math.max(120, (node.size[0] - 27) * scale)}px`,
      height: `${Math.max(22, (CARD_HEADER_HEIGHT - 6) * scale)}px`,
      boxSizing: "border-box",
      zIndex: "100000",
      border: "1px solid #70d6a1",
      borderRadius: `${Math.max(3, 4 * scale)}px`,
      outline: "none",
      background: "#181818",
      color: "#e6eee9",
      padding: `0 ${Math.max(6, 8 * scale)}px`,
      font: `600 ${Math.max(11, 12 * scale)}px Inter, Arial, sans-serif`,
      boxShadow: "0 0 0 1px rgba(83, 164, 196, .28)",
    });
    input.addEventListener("keydown", (keyboardEvent) => {
      if (keyboardEvent.key === "Enter") {
        keyboardEvent.preventDefault();
        finishRename(true);
      } else if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        finishRename(false);
      }
    });
    input.addEventListener("blur", () => finishRename(true), { once: true });
    document.body.appendChild(input);
    renameEditor = { input, group };
    input.focus();
    input.select();
  };

  const previousBackground = node.onDrawBackground;
  node.onDrawBackground = function (ctx) {
    const currentWidth = Math.max(Number(node.size?.[0]) || 0, MIN_NODE_WIDTH);
    const layout = node.__powerModelLayout;
    if (!layout || layout.width !== currentWidth || node.size[1] !== layout.nodeHeight) {
      applyLayout();
    }
    previousBackground?.apply(this, arguments);
    const width = node.size[0];
    ctx.save();

    state.groups.forEach((group, index) => {
      const y = cardY(index);
      const active = group.id === state.activeGroup;
      roundedRect(ctx, 7, y, width - 14, CARD_HEIGHT, 7);
      ctx.fillStyle = active ? "#293b31" : "#282828";
      ctx.fill();
      ctx.strokeStyle = active ? "#70d6a1" : "#484848";
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(7, y + CARD_HEADER_HEIGHT);
      ctx.lineTo(width - 7, y + CARD_HEADER_HEIGHT);
      ctx.strokeStyle = active ? "#527b63" : "#484848";
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    ctx.restore();
  };

  const previousForeground = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    refreshLiveNames();
    previousForeground?.apply(this, arguments);
    const width = node.size[0];
    ctx.save();
    ctx.font = "600 12px Inter, Arial, sans-serif";
    ctx.textBaseline = "middle";
    const buttonY = node.__powerModelLayout.controlsTop;
    roundedRect(ctx, 14, buttonY, width - 28, 30, 6);
    ctx.fillStyle = state.groups.length < MAX_GROUPS ? '#70d6a1' : '#4c5850';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0b3020';
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillText('+ Add group', width / 2, buttonY + 15);
    ctx.textAlign = 'left';
    ctx.textAlign = 'right';
    ctx.font = '12px Inter, Arial, sans-serif';
    ctx.fillStyle = '#b6c4bb';
    KINDS.forEach(([,type], index) => ctx.fillText(type, width - 13, 20 + index * 24));
    ctx.textAlign = 'left';

    ctx.fillStyle = "#a2b2a7";
    ctx.font = "700 9px Inter, Arial, sans-serif";
    ctx.fillText("MODEL GROUPS", 12, CARD_TOP - 13);
    const complete = state.groups.filter(g => connectionCount(g) === 3).length;
    ctx.textAlign = 'right';
    ctx.fillText(`${complete} connected / ${state.groups.length} groups`, width - 14, CARD_TOP - 13);
    ctx.textAlign = 'left';
    const selected = state.groups.find(g => g.id === state.activeGroup);
    ctx.fillText('ACTIVE MODEL GROUP', 18, 20);
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillStyle = '#e6eee9';
    ctx.fillText(fitText(ctx, groupTitle(selected), width - 140), 18, 42);
    ctx.font = '10px Inter, Arial, sans-serif';
    ctx.fillStyle = '#a9c0b2';
    ctx.fillText(bypassedSources(selected)
      ? 'Bypassed loaders · restored when queued'
      : `${connectionCount(selected)} / 3 inputs connected`, 18, 65);

    state.groups.forEach((group, index) => {
      const y = cardY(index);
      const active = group.id === state.activeGroup;
      ctx.fillStyle = active ? "#d9ffea" : "#e6eee9";
      ctx.font = "650 12px Inter, Arial, sans-serif";
      ctx.fillText(fitText(ctx, groupTitle(group), width - 160), 34, y + 19);
      ctx.font = '9px Inter, Arial, sans-serif';
      ctx.fillStyle = '#a1b7a8';
      ctx.fillText(String(index + 1).padStart(2, '0'), 14, y + 19);
      ctx.fillText(group.autoTitle !== false ? 'Title from connected source' : 'Custom title', 34, y + 37);
      ctx.textAlign = 'right';
      ctx.fillText(`${connectionCount(group)}/3`, width - (active ? 95 : 20), y + 19);
      ctx.textAlign = 'left';
      KINDS.forEach(([kind, type], row) => {
        const input = node.inputs?.find(i => i.name === inputName(group.id, kind));
        const rowY = y + SLOT_FIRST_OFFSET + row * SLOT_ROW_HEIGHT;
        ctx.font = '600 10px Inter, Arial, sans-serif';
        ctx.fillStyle = '#b6c4bb';
        ctx.fillText(type, 18, rowY);
        ctx.font = '11px Inter, Arial, sans-serif';
        ctx.fillStyle = '#a2b2a7';
        ctx.fillText(fitText(ctx, input?.__luciFilename || 'not connected', width - 100), 76, rowY);
      });
      if (active) {
        const badge = "SELECTED";
        ctx.font = "800 8px Inter, Arial, sans-serif";
        const badgeWidth = ctx.measureText(badge).width + 14;
        roundedRect(ctx, width - badgeWidth - 17, y + 7, badgeWidth, 16, 4);
        ctx.fillStyle = "#315a3f";
        ctx.fill();
        ctx.fillStyle = "#d9ffea";
        ctx.fillText(badge, width - badgeWidth - 10, y + 15.5);
      }
    });

    ctx.restore();
  };

  const groupAtHeaderPosition = (pos) => {
    if (!Array.isArray(pos) || pos.length < 2) return null;
    if (pos[0] < 7 || pos[0] > node.size[0] - 7) return null;
    return state.groups.find((_group, index) => {
      const y = cardY(index);
      return pos[1] >= y && pos[1] <= y + CARD_HEADER_HEIGHT;
    }) ?? null;
  };

  const groupAtCardPosition = (pos) => {
    if (!Array.isArray(pos) || pos.length < 2) return null;
    if (pos[0] < 7 || pos[0] > node.size[0] - 7) return null;
    return state.groups.find((_group, index) => {
      const y = cardY(index);
      return pos[1] >= y && pos[1] <= y + CARD_HEIGHT;
    }) ?? null;
  };

  node.__luciOpenGroupMenu = (event, pos, canvas) => {
    const hit = groupAtCardPosition(pos);
    if (!hit) return false;
    closeLuciMenu();
    const id = hit.id;
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position:'fixed', left:`${Math.max(0,Math.min(event.clientX,window.innerWidth-240))}px`,
      top:`${Math.max(0,Math.min(event.clientY,window.innerHeight-180))}px`,
      width:'230px', padding:'6px', background:'#282828', color:'#e6eee9',
      border:'1px solid #484848',borderRadius:'7px',zIndex:'100000',
      boxShadow:'0 8px 30px #0008',font:'12px Inter,Arial,sans-serif',
    });
    const heading = document.createElement('div');
    heading.textContent = groupTitle(hit);
    Object.assign(heading.style,{padding:'8px',color:'#a1b7a8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
    menu.appendChild(heading);
    const action = (label, callback, disabled=false) => {
      const button=document.createElement('button');
      button.type='button'; button.textContent=label; button.disabled=disabled;
      Object.assign(button.style,{display:'block',width:'100%',textAlign:'left',padding:'10px 8px',
        background:'transparent',border:'0',borderRadius:'4px',color:label.startsWith('Delete')?'#ff9898':'#e6eee9',
        cursor:disabled?'default':'pointer',opacity:disabled?'.4':'1',font:'inherit'});
      button.onmouseenter=()=>{button.style.background='#304b3b';};
      button.onmouseleave=()=>{button.style.background='transparent';};
      button.onclick=()=>{ closeLuciMenu(); const group=state.groups.find(g=>g.id===id); if(group)callback(group); };
      menu.appendChild(button);
    };
    action('Rename this group',group=>startInlineRename(group,event,pos,canvas));
    action('Use connected title',group=>{group.autoTitle=true;refresh();});
    action('Delete this group',removeGroup,state.groups.length===1);
    document.body.appendChild(menu);
    luciMenu=menu;
    return true;
  };

  const showGroupMenu = (group, event, pos, canvas) => {
    const ContextMenu = globalThis.LiteGraph?.ContextMenu ?? window.LiteGraph?.ContextMenu;
    if (!ContextMenu) return false;
    new ContextMenu(
      [
        {
          content: "Rename group",
          callback: () => startInlineRename(group, event, pos, canvas),
        },
        null,
        {
          content: 'Use connected title',
          callback: () => { const target = state.groups.find(g => g.id === group.id); if(target) target.autoTitle = true; refresh(); },
        },
        {
          content: "Delete group",
          disabled: state.groups.length === 1,
          callback: () => removeGroup(group),
        },
      ],
      { event, node },
    );
    return true;
  };

  // Right-clicks can go straight to LiteGraph's context-menu path without
  // invoking onMouseDown. Add group actions through that native hook too.
  const previousExtraMenu = node.getExtraMenuOptions;
  node.getExtraMenuOptions = function (canvas, options) {
    const result = previousExtraMenu?.apply(this, arguments);
    const pointer = canvas?.graph_mouse ?? canvas?.graphMouse;
    const local = pointer ? [pointer[0] - this.pos[0], pointer[1] - this.pos[1]] : null;
    const hit = groupAtCardPosition(local);
    const target = hit ?? state.groups.find(g => g.id === state.activeGroup);
    if (!target) return result;
    const id = target.id;
    const liveGroup = () => state.groups.find(g => g.id === id);
    const entries = [
      { content: `${hit ? 'This group' : 'Selected group'}: ${groupTitle(target)}`, disabled: true },
      {
        content: 'Rename this group',
        callback: () => {
          const group = liveGroup();
          if (!group) return;
          const rect = canvas?.canvas?.getBoundingClientRect?.();
          const scale = canvas?.ds?.scale || 1;
          const offset = canvas?.ds?.offset || [0,0];
          const index = state.groups.findIndex(g => g.id === id);
          const pos = [18, cardY(index) + 10];
          const event = {
            clientX: (rect?.left || 0) + (this.pos[0] + pos[0] + offset[0]) * scale,
            clientY: (rect?.top || 0) + (this.pos[1] + pos[1] + offset[1]) * scale,
          };
          startInlineRename(group, event, pos, canvas);
        },
      },
      {
        content: 'Use connected title',
        callback: () => { const group = liveGroup(); if(group) { group.autoTitle = true; refresh(); } },
      },
      {
        content: 'Delete this group',
        disabled: state.groups.length === 1,
        callback: () => { const group = liveGroup(); if(group) removeGroup(group); },
      },
      null,
    ];
    // Some frontend versions consume the returned list; classic LiteGraph
    // also permits mutating the provided options array. Support both paths.
    if (Array.isArray(options)) options.unshift(...entries);
    return [...entries, ...(Array.isArray(result) ? result : [])];
  };

  const previousDoubleClick = node.onDblClick;
  node.onDblClick = function (event, pos, canvas) {
    const group = groupAtHeaderPosition(pos);
    if (group) {
      state.activeGroup = group.id;
      refresh();
      const currentGroup = state.groups.find((candidate) => candidate.id === group.id);
      if (currentGroup) startInlineRename(currentGroup, event, pos, canvas);
      event?.preventDefault?.();
      event?.stopPropagation?.();
      return true;
    }
    return previousDoubleClick?.call(this, event, pos, canvas);
  };

  const previousMouseDown = node.onMouseDown;
  node.onMouseDown = function (event, pos, canvas) {
    const buttonY = node.__powerModelLayout?.controlsTop;
    if ((event?.button ?? 0) === 0 && pos && pos[0] >= 14 && pos[0] <= node.size[0] - 14
        && pos[1] >= buttonY && pos[1] <= buttonY + 30) {
      if (state.groups.length < MAX_GROUPS) addWidget.callback();
      event?.preventDefault?.();
      event?.stopPropagation?.();
      return true;
    }
    const headerGroup = groupAtCardPosition(pos);
    if (event?.button === 2 && headerGroup) {
      state.activeGroup = headerGroup.id;
      refresh();
      const currentGroup = state.groups.find((candidate) => candidate.id === headerGroup.id);
      if (currentGroup && showGroupMenu(currentGroup, event, pos, canvas)) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return true;
      }
    }

    const cardGroup = groupAtCardPosition(pos);
    if ((event?.button ?? 0) === 0 && cardGroup) {
      if (state.activeGroup !== cardGroup.id) {
        state.activeGroup = cardGroup.id;
        refresh();
      }
      return true;
    }
    return previousMouseDown?.call(this, event, pos, canvas);
  };

  const previousRemoved = node.onRemoved;
  node.onRemoved = function () {
    luciNodes.delete(this);
    closeLuciMenu();
    finishRename(false);
    return previousRemoved?.apply(this, arguments);
  };

  const previousResize = node.onResize;
  node.onResize = function (size) {
    const result = previousResize?.apply(this, arguments);
    if (!applyingLayout) applyLayout();
    return result;
  };

  node.computeSize = function () {
    // LiteGraph uses computeSize as the lower bound while dragging a resize
    // handle. Returning the current width here makes that bound ratchet up.
    return [MIN_NODE_WIDTH,
      this.__powerModelLayout?.nodeHeight ?? 320];
  };

  const previousConnectionPosition = node.getConnectionPos;
  node.getConnectionPos = function (isInput, slot, out) {
    const port = (isInput ? this.inputs : this.outputs)?.[slot];
    if (port?.pos && !this.flags?.collapsed) {
      const result = out || new Float32Array(2);
      result[0] = this.pos[0] + port.pos[0];
      result[1] = this.pos[1] + port.pos[1];
      return result;
    }
    return previousConnectionPosition?.apply(this, arguments);
  };

  node.__powerModelLoaderRestore = () => {
    state = parseStoredState(node);
    refresh();
  };

  refresh();
}

app.registerExtension({
  name: "power-model-loader.ui",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      installPowerModelUi(this);
      return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigure?.apply(this, arguments);
      if (['👻 Power Model Loader', 'Power Model Loader'].includes(this.title)) this.title = '👻 Luci Model Loader';
    this.color = '#202020';this.bgcolor = '#282828';
    this.__powerModelLoaderRestore?.();
      return result;
    };
  },
});
