import { readFile } from "node:fs/promises";

import sharp from "sharp";

export const NUGLET_INFOGRAPHIC_RENDERER_VERSION = "nuglet-editorial-svg@1.0.0";
export const NUGLET_INFOGRAPHIC_WIDTH = 1080;
export const NUGLET_INFOGRAPHIC_HEIGHT = 1920;

const SYMBOLS = new Set([
  "book",
  "speech",
  "knot",
  "bridge",
  "compass",
  "thread",
  "seedling",
  "steps",
  "mirror",
  "balance",
]);
const ACCENTS = new Set(["clay", "sage", "blue"]);
const PATHS = new Set(["loop", "rise", "bridge"]);
const PALE_ACCENTS = {
  clay: "#E8C2AE",
  sage: "#C9D8BF",
  blue: "#BDD7DE",
};

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lessonPayload(content) {
  const value = record(content);
  const payload = record(value.payload);
  return Object.keys(payload).length ? payload : value;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

export function infographicSource(content) {
  const payload = lessonPayload(content);
  const identity = record(payload.identity);
  const learning = record(payload.learning);
  const action = record(learning.action);
  const visual = record(payload.visual);
  const visualBrief = record(visual.mediaBrief);
  const read = record(payload.read);
  const story = record(read.story);
  const playbook = record(read.playbook);
  const playbookSteps = Array.isArray(playbook.steps) ? playbook.steps.map(record) : [];
  const visualSteps = Array.isArray(visual.textEquivalent)
    ? visual.textEquivalent.map(string).filter(Boolean)
    : [];
  const playbookSequence = playbookSteps
    .map((step) => {
      const body = string(step.body);
      const title = string(step.title);
      return body && copyFits(body, 32, 5) ? body : title ?? body;
    })
    .filter(Boolean);
  const learningSequence = [
    string(learning.whyItMatters),
    string(action.instruction),
  ].filter(Boolean);
  const candidates = [visualSteps, playbookSequence, learningSequence]
    .map((candidate) => dedupe(candidate).slice(0, 4))
    .filter((candidate) => candidate.length >= 2);
  const steps = candidates.find((candidate) => candidate.every((step) => copyFits(step, 32, 5)))
    ?? candidates[0]
    ?? [];
  if (steps.length < 2) throw new Error("infographic source requires at least two checked teaching steps");

  return {
    eyebrow: "VISUAL SUMMARY",
    title: string(visual.title)
      ?? string(identity.title)
      ?? string(story.title)
      ?? "One useful idea",
    deck: string(identity.deck)
      ?? string(learning.centralIdea)
      ?? string(visualBrief.objective)
      ?? steps[0],
    steps,
    closing: string(learning.oneLineToKeep)
      ?? string(action.instruction)
      ?? string(playbook.action)
      ?? steps.at(-1),
    altText: string(visual.altText)
      ?? `A Nuglet visual summary of ${string(identity.title) ?? string(visual.title) ?? "the lesson"}.`,
  };
}

export function infographicPlanningPrompt(content, recipeCanonicalJson) {
  const source = infographicSource(content);
  return [
    "Act as Nuglet's visual art director.",
    "Choose only the restrained art direction for a deterministic editorial infographic. The renderer owns all copy, typography, spacing, and drawing.",
    "Do not rewrite, summarize, correct, or return the learner-facing copy.",
    "Use the checked lesson source below only to choose concise stage labels and symbolic drawings.",
    `Checked source: ${JSON.stringify(source)}`,
    `Approved recipe: ${recipeCanonicalJson}`,
    `Return only strict JSON with exactly this shape: {"stageLabels":["two or three words"],"symbols":["book"],"accent":"sage","path":"loop"}.`,
    `stageLabels must contain exactly ${source.steps.length} labels, one per checked step, in the same order.`,
    "Each label must be 1-3 plain words and at most 24 characters.",
    `Each symbol must be one of: ${[...SYMBOLS].join(", ")}.`,
    `accent must be one of: ${[...ACCENTS].join(", ")}.`,
    `path must be one of: ${[...PATHS].join(", ")}.`,
    "Prefer one coherent metaphor family. Avoid repeating the same symbol unless the lesson truly repeats the same action.",
    "No markdown, commentary, extra keys, or additional copy.",
  ].join("\n");
}

export function parseInfographicArtDirection(value, stageCount) {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = record(JSON.parse(normalized));
  } catch {
    throw new Error("infographic planner returned invalid JSON");
  }
  const allowedKeys = ["accent", "path", "stageLabels", "symbols"];
  if (Object.keys(parsed).some((key) => !allowedKeys.includes(key))) {
    throw new Error("infographic planner returned unsupported keys");
  }
  const stageLabels = Array.isArray(parsed.stageLabels)
    ? parsed.stageLabels.map(string)
    : [];
  const symbols = Array.isArray(parsed.symbols)
    ? parsed.symbols.map(string)
    : [];
  if (stageLabels.length !== stageCount
    || stageLabels.some((label) => !label || label.length > 24 || label.split(/\s+/).length > 3)) {
    throw new Error("infographic planner returned invalid stage labels");
  }
  if (symbols.length !== stageCount || symbols.some((symbol) => !symbol || !SYMBOLS.has(symbol))) {
    throw new Error("infographic planner returned invalid symbols");
  }
  if (!string(parsed.accent) || !ACCENTS.has(parsed.accent)) {
    throw new Error("infographic planner returned an invalid accent");
  }
  if (!string(parsed.path) || !PATHS.has(parsed.path)) {
    throw new Error("infographic planner returned an invalid path");
  }
  return {
    stageLabels,
    symbols,
    accent: parsed.accent,
    path: parsed.path,
  };
}

export async function renderNugletInfographic(content, artDirection) {
  const source = infographicSource(content);
  if (artDirection.stageLabels.length !== source.steps.length
    || artDirection.symbols.length !== source.steps.length) {
    throw new Error("infographic art direction does not match checked teaching steps");
  }
  const [fraunces, bricolageRegular, bricolageSemibold] = await Promise.all([
    readFile(new URL("../assets/nuglet-short/FrauncesDisplay.ttf", import.meta.url)),
    readFile(new URL("../assets/nuglet-short/BricolageGrotesqueRegular.ttf", import.meta.url)),
    readFile(new URL("../assets/nuglet-short/BricolageGrotesqueSemibold.ttf", import.meta.url)),
  ]);
  const svg = renderInfographicSvg(source, artDirection, {
    fraunces: fraunces.toString("base64"),
    bricolageRegular: bricolageRegular.toString("base64"),
    bricolageSemibold: bricolageSemibold.toString("base64"),
  });
  const bytes = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return { bytes, source, svg };
}

export function renderInfographicSvg(source, artDirection, fonts = {}) {
  const stageCount = source.steps.length;
  const headlineLines = wrapText(source.title, 19, 4);
  const deckLines = wrapText(source.deck, 43, 4);
  const headlineTop = 190;
  const deckTop = headlineTop + (headlineLines.length * 104) + 26;
  const contentTop = Math.max(680, deckTop + (deckLines.length * 42) + 100);
  const contentBottom = 1540;
  const gap = stageCount === 1 ? 0 : (contentBottom - contentTop) / (stageCount - 1);
  const positions = source.steps.map((_, index) => {
    const left = index % 2 === 0;
    return {
      y: Math.round(contentTop + (gap * index)),
      textX: left ? 92 : 592,
      iconX: left ? 770 : 310,
      left,
    };
  });
  const path = flowPath(positions, artDirection.path);
  const paleAccent = PALE_ACCENTS[artDirection.accent];
  const grain = Array.from({ length: 80 }, (_, index) => {
    const x = (index * 137) % NUGLET_INFOGRAPHIC_WIDTH;
    const y = (index * 239) % NUGLET_INFOGRAPHIC_HEIGHT;
    const radius = index % 3 === 0 ? 1.2 : 0.7;
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#6E665C" opacity="0.07"/>`;
  }).join("");
  const stages = positions.map((position, index) => {
    const label = `${String(index + 1).padStart(2, "0")}  ${artDirection.stageLabels[index].toUpperCase()}`;
    const bodyLines = wrapText(source.steps[index], 32, 5);
    return `
      <g aria-label="${escapeXml(`${label}. ${source.steps[index]}`)}">
        <circle cx="${position.iconX}" cy="${position.y}" r="104" fill="${paleAccent}" opacity="0.62"/>
        ${symbolSvg(artDirection.symbols[index], position.iconX, position.y)}
        <text x="${position.textX}" y="${position.y - 24}" class="stage-label">${escapeXml(label)}</text>
        <text x="${position.textX}" y="${position.y + 28}" class="stage-copy">
          ${tspans(bodyLines, position.textX, 36)}
        </text>
      </g>`;
  }).join("");
  const closingLines = wrapText(source.closing, 60, 3);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${NUGLET_INFOGRAPHIC_WIDTH}" height="${NUGLET_INFOGRAPHIC_HEIGHT}" viewBox="0 0 ${NUGLET_INFOGRAPHIC_WIDTH} ${NUGLET_INFOGRAPHIC_HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(source.title)}</title>
  <desc id="description">${escapeXml(source.altText)}</desc>
  <style>
    ${fonts.fraunces ? `@font-face { font-family: "Nuglet Fraunces"; src: url(data:font/ttf;base64,${fonts.fraunces}) format("truetype"); }` : ""}
    ${fonts.bricolageRegular ? `@font-face { font-family: "Nuglet Bricolage"; src: url(data:font/ttf;base64,${fonts.bricolageRegular}) format("truetype"); font-weight: 400; }` : ""}
    ${fonts.bricolageSemibold ? `@font-face { font-family: "Nuglet Bricolage"; src: url(data:font/ttf;base64,${fonts.bricolageSemibold}) format("truetype"); font-weight: 600; }` : ""}
    .eyebrow { font: 600 21px "Nuglet Bricolage", sans-serif; letter-spacing: 6px; fill: #0B6664; }
    .headline { font: 400 92px "Nuglet Fraunces", Georgia, serif; fill: #171512; }
    .deck { font: 400 31px "Nuglet Bricolage", sans-serif; fill: #625E57; }
    .stage-label { font: 600 21px "Nuglet Bricolage", sans-serif; letter-spacing: 4px; fill: #0B6664; }
    .stage-copy { font: 400 30px "Nuglet Fraunces", Georgia, serif; fill: #171512; }
    .closing { font: 600 26px "Nuglet Bricolage", sans-serif; letter-spacing: 3px; fill: #0B6664; }
    .ink { fill: none; stroke: #171512; stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
    .soft-ink { fill: none; stroke: #0B6664; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <rect width="1080" height="1920" fill="#F4EFE4"/>
  ${grain}
  <text x="92" y="112" class="eyebrow">${escapeXml(source.eyebrow)}</text>
  <text x="92" y="${headlineTop}" class="headline">${tspans(headlineLines, 92, 104)}</text>
  <line x1="92" y1="${deckTop - 30}" x2="190" y2="${deckTop - 30}" stroke="#E87817" stroke-width="5"/>
  <text x="92" y="${deckTop}" class="deck">${tspans(deckLines, 92, 42)}</text>
  <path d="${path}" fill="none" stroke="#817A70" stroke-width="3" stroke-linecap="round" opacity="0.58"/>
  ${stages}
  <circle cx="92" cy="1760" r="8" fill="#E87817"/>
  <line x1="112" y1="1760" x2="286" y2="1760" stroke="#171512" stroke-width="3"/>
  <text x="92" y="1812" class="closing">${tspans(closingLines.map((line) => line.toUpperCase()), 92, 36)}</text>
</svg>`;
}

function flowPath(positions, pathKind) {
  const points = positions.map(({ iconX, y }) => [iconX, y]);
  if (points.length < 2) return "";
  let value = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length; index += 1) {
    const [previousX, previousY] = points[index - 1];
    const [x, y] = points[index];
    const bend = pathKind === "rise" ? 80 : pathKind === "bridge" ? 150 : 120;
    const middleY = Math.round((previousY + y) / 2);
    value += ` C ${previousX + (previousX < x ? bend : -bend)} ${middleY}, ${x + (previousX < x ? -bend : bend)} ${middleY}, ${x} ${y}`;
  }
  if (pathKind === "loop") {
    const [lastX, lastY] = points.at(-1);
    value += ` C ${lastX - 12} ${lastY + 90}, 170 1710, 92 1760`;
  }
  return value;
}

function symbolSvg(symbol, x, y) {
  const left = x - 62;
  const top = y - 62;
  if (symbol === "book") {
    return `<path class="ink" d="M ${left} ${top + 18} Q ${x - 22} ${top + 4} ${x} ${top + 24} Q ${x + 22} ${top + 4} ${x + 62} ${top + 18} V ${y + 52} Q ${x + 22} ${y + 37} ${x} ${y + 55} Q ${x - 22} ${y + 37} ${left} ${y + 52} Z M ${x} ${top + 24} V ${y + 55}"/>`;
  }
  if (symbol === "speech") {
    return `<path class="ink" d="M ${left} ${top + 10} H ${x + 62} Q ${x + 76} ${top + 10} ${x + 76} ${top + 26} V ${y + 24} Q ${x + 76} ${y + 40} ${x + 58} ${y + 40} H ${x - 8} L ${x - 38} ${y + 64} L ${x - 30} ${y + 40} H ${left} Q ${x - 76} ${y + 40} ${x - 76} ${y + 24} V ${top + 26} Q ${x - 76} ${top + 10} ${left} ${top + 10} Z"/><path class="soft-ink" d="M ${x - 38} ${y - 8} H ${x + 38} M ${x - 28} ${y + 10} H ${x + 16}"/>`;
  }
  if (symbol === "knot") {
    return `<path class="ink" d="M ${x - 55} ${y - 8} C ${x - 24} ${y - 70}, ${x + 28} ${y + 68}, ${x + 58} ${y - 8} C ${x + 84} ${y - 58}, ${x - 78} ${y - 60}, ${x - 55} ${y + 26} C ${x - 38} ${y + 84}, ${x + 66} ${y + 65}, ${x + 45} ${y - 46} C ${x + 34} ${y - 88}, ${x - 33} ${y - 62}, ${x - 30} ${y + 48}"/>`;
  }
  if (symbol === "bridge") {
    return `<path class="ink" d="M ${left - 5} ${y + 48} H ${x - 55} V ${y + 18} Q ${x} ${y - 76} ${x + 55} ${y + 18} V ${y + 48} H ${x + 67} M ${x - 55} ${y + 18} Q ${x} ${y - 30} ${x + 55} ${y + 18}"/><path class="soft-ink" d="M ${x - 50} ${y - 2} L ${x - 26} ${y + 7} M ${x - 25} ${y - 28} L ${x - 9} ${y - 11} M ${x + 20} ${y - 25} L ${x + 8} ${y - 8} M ${x + 44} ${y - 1} L ${x + 28} ${y + 9}"/>`;
  }
  if (symbol === "compass") {
    return `<circle class="ink" cx="${x}" cy="${y}" r="64"/><path class="ink" d="M ${x + 20} ${y - 34} L ${x - 10} ${y + 15} L ${x - 34} ${y + 32} L ${x - 15} ${y + 4} Z"/><circle cx="${x}" cy="${y}" r="7" fill="#E87817"/>`;
  }
  if (symbol === "thread") {
    return `<path class="ink" d="M ${left - 8} ${y + 28} C ${x - 20} ${y - 74}, ${x + 12} ${y + 74}, ${x + 65} ${y - 36}"/><circle cx="${left - 8}" cy="${y + 28}" r="9" fill="#E87817"/><circle cx="${x + 65}" cy="${y - 36}" r="9" fill="#0B6664"/>`;
  }
  if (symbol === "seedling") {
    return `<path class="ink" d="M ${x} ${y + 58} V ${y - 28}"/><path class="soft-ink" d="M ${x} ${y - 4} C ${x - 50} ${y - 15}, ${x - 58} ${y - 54}, ${x - 14} ${y - 50} C ${x - 4} ${y - 33}, ${x - 2} ${y - 18}, ${x} ${y - 4} M ${x} ${y + 15} C ${x + 50} ${y + 6}, ${x + 58} ${y - 36}, ${x + 14} ${y - 32} C ${x + 4} ${y - 14}, ${x + 2} ${y + 2}, ${x} ${y + 15}"/><path class="ink" d="M ${x - 64} ${y + 58} Q ${x} ${y + 34} ${x + 64} ${y + 58}"/>`;
  }
  if (symbol === "steps") {
    return `<path class="ink" d="M ${left} ${y + 58} H ${x - 24} V ${y + 18} H ${x + 14} V ${y - 22} H ${x + 58} V ${y - 62} H ${x + 72}"/><circle cx="${left}" cy="${y + 58}" r="8" fill="#E87817"/>`;
  }
  if (symbol === "mirror") {
    return `<ellipse class="ink" cx="${x}" cy="${y - 8}" rx="47" ry="62"/><path class="ink" d="M ${x} ${y + 54} V ${y + 74} M ${x - 26} ${y + 74} H ${x + 26}"/><path class="soft-ink" d="M ${x - 18} ${y - 42} Q ${x + 2} ${y - 58} ${x + 20} ${y - 36}"/>`;
  }
  return `<path class="ink" d="M ${x} ${y - 62} V ${y + 50} M ${x - 58} ${y - 34} H ${x + 58} M ${x - 44} ${y - 34} L ${x - 68} ${y + 14} H ${x - 20} Z M ${x + 44} ${y - 34} L ${x + 20} ${y + 14} H ${x + 68} Z M ${x - 32} ${y + 50} H ${x + 32}"/>`;
}

function wrapText(value, maxCharacters, maxLines) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    throw new Error(`infographic checked copy exceeds the ${maxLines}-line layout limit`);
  }
  return lines;
}

function copyFits(value, maxCharacters, maxLines) {
  try {
    wrapText(value, maxCharacters, maxLines);
    return true;
  } catch {
    return false;
  }
}

function tspans(lines, x, lineHeight) {
  return lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
