import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

export const PUBLIC_PREVIEW_END_CARD_VERSION = "nuglet.short-end-card@2.2.0";
export const PUBLIC_PREVIEW_END_CARD_SECONDS = 3;
export const PUBLIC_PREVIEW_END_CARD_TRANSITION_SECONDS = 0.45;
export const PUBLIC_PREVIEW_END_CARD_VOICE_OVERLAP_SECONDS = 0.65;
export const PUBLIC_PREVIEW_MAX_SECONDS = 65;
export const PUBLIC_PREVIEW_PROVIDER_TAIL_SECONDS = 8;

const END_CARD_BACKGROUND = new URL(
  "../assets/nuglet-short/focus-aperture-end-card.png",
  import.meta.url,
).pathname;
const NUGLET_LOGO = new URL(
  "../assets/nuglet-short/nuglet-logo.png",
  import.meta.url,
).pathname;
const DISPLAY_FONT = new URL(
  "../assets/nuglet-short/FrauncesDisplay.ttf",
  import.meta.url,
).pathname;
const BODY_FONT_REGULAR = new URL(
  "../assets/nuglet-short/BricolageGrotesqueRegular.ttf",
  import.meta.url,
).pathname;
const BODY_FONT_SEMIBOLD = new URL(
  "../assets/nuglet-short/BricolageGrotesqueSemibold.ttf",
  import.meta.url,
).pathname;
const FONTCONFIG_FILE = new URL(
  "../assets/nuglet-short/fonts.conf",
  import.meta.url,
).pathname;

function checksum(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requiredTitle(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("public preview title is required");
  return value.trim();
}

export function wrapEndCardTitle(value, maxLineCharacters = 18, maxLines = 3) {
  const words = requiredTitle(value).split(/\s+/);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || (current.length + 1 + word.length > maxLineCharacters && lines.length < maxLines)) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return lines;
}

export function publicPreviewEndCardPlan(metadata, title, options = {}) {
  const providerDurationSeconds = Number(metadata?.durationSeconds);
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  if (!Number.isFinite(providerDurationSeconds) || providerDurationSeconds <= 0
    || !Number.isInteger(width) || width <= 0
    || !Number.isInteger(height) || height <= 0
    || metadata?.hasAudio !== true) {
    throw new Error("public preview video must have positive dimensions, duration, and audio");
  }
  const providerTailSeconds = Number.isFinite(options.providerTailSeconds)
    ? Math.max(0, Number(options.providerTailSeconds))
    : PUBLIC_PREVIEW_PROVIDER_TAIL_SECONDS;
  const minimumEndCardDurationSeconds = Number.isFinite(options.endCardDurationSeconds)
    ? Math.min(PUBLIC_PREVIEW_MAX_SECONDS - 1, Math.max(0.25, Number(options.endCardDurationSeconds)))
    : PUBLIC_PREVIEW_END_CARD_SECONDS;
  const endCardTransitionSeconds = Number.isFinite(options.endCardTransitionSeconds)
    ? Math.min(0.75, Math.max(0.1, Number(options.endCardTransitionSeconds)))
    : PUBLIC_PREVIEW_END_CARD_TRANSITION_SECONDS;
  const endCardVoiceOverlapSeconds = Number.isFinite(options.endCardVoiceOverlapSeconds)
    ? Math.min(1.5, Math.max(0, Number(options.endCardVoiceOverlapSeconds)))
    : PUBLIC_PREVIEW_END_CARD_VOICE_OVERLAP_SECONDS;
  const contentDurationSeconds = Math.max(
    1,
    Math.min(
      providerDurationSeconds - Math.max(providerTailSeconds, minimumEndCardDurationSeconds),
      PUBLIC_PREVIEW_MAX_SECONDS - minimumEndCardDurationSeconds,
    ),
  );
  const titleLines = wrapEndCardTitle(title);
  const titleFontSize = titleLines.length === 1 ? 96 : titleLines.length === 2 ? 90 : 66;
  const finalDurationSeconds = Math.min(providerDurationSeconds, PUBLIC_PREVIEW_MAX_SECONDS);
  const audioSourceDurationSeconds = Math.min(providerDurationSeconds, finalDurationSeconds);
  const endCardDurationSeconds = finalDurationSeconds - contentDurationSeconds;
  return {
    providerDurationSeconds,
    providerTailSeconds: providerDurationSeconds - contentDurationSeconds,
    contentDurationSeconds,
    audioSourceDurationSeconds,
    audioTailTrimSeconds: providerDurationSeconds - audioSourceDurationSeconds,
    endCardDurationSeconds,
    endCardTransitionSeconds,
    endCardVoiceOverlapSeconds,
    finalDurationSeconds,
    width,
    height,
    titleLines,
    titleFontSize,
  };
}

export async function renderPublicPreviewVideo(bytes, title, options = {}) {
  for (const path of [
    END_CARD_BACKGROUND,
    NUGLET_LOGO,
    DISPLAY_FONT,
    BODY_FONT_REGULAR,
    BODY_FONT_SEMIBOLD,
    FONTCONFIG_FILE,
  ]) {
    if (!existsSync(path)) throw new Error(`public preview end-card asset missing: ${path}`);
  }
  const ffmpeg = (options.ffmpegCommand || process.env.FFMPEG_COMMAND || "ffmpeg").trim();
  const ffprobe = (options.ffprobeCommand || process.env.FFPROBE_COMMAND || "ffprobe").trim();
  const directory = await mkdtemp(join(tmpdir(), "knowledge-bits-public-preview-render-"));
  const inputPath = join(directory, "provider.mp4");
  const outputPath = join(directory, "review.mp4");
  const cardPath = join(directory, "end-card.png");
  try {
    await writeFile(inputPath, bytes);
    const providerMetadata = await videoMetadata(inputPath, ffprobe);
    const plan = publicPreviewEndCardPlan(providerMetadata, title, options);

    const width = plan.width;
    const height = plan.height;
    const content = plan.contentDurationSeconds.toFixed(3);
    const audioSource = plan.audioSourceDurationSeconds.toFixed(3);
    const total = plan.finalDurationSeconds.toFixed(3);
    const footerHeight = Math.max(34, Math.round(height * 0.04));
    const footerLogoWidth = Math.max(74, Math.round(width * 0.12));
    const cardLogoWidth = Math.max(250, Math.round(width * 0.39));
    const pangoView = (options.pangoViewCommand || process.env.PANGO_VIEW_COMMAND || "pango-view").trim();
    const titleY = Math.round(height * 0.55);
    const supportY = Math.round(height * 0.715);
    const ctaY = Math.round(height * 0.79);
    const logoY = Math.round(height * 0.86);
    await renderEndCard(cardPath, {
      width,
      height,
      titleLines: plan.titleLines,
      titleFontSize: plan.titleFontSize,
      titleY,
      supportY,
      ctaY,
      logoY,
      cardLogoWidth,
      directory,
      pangoView,
      displayFont: "Nuglet Fraunces",
      supportFont: "Nuglet Bricolage Regular",
      ctaFont: "Nuglet Bricolage",
      endCardArtworkBytes: options.endCardArtworkBytes,
    });
    const transition = plan.endCardTransitionSeconds.toFixed(3);
    const transitionStart = Math.max(
      0,
      plan.contentDurationSeconds
        - plan.endCardTransitionSeconds
        - plan.endCardVoiceOverlapSeconds,
    ).toFixed(3);
    const audioFadeDuration = Math.min(0.04, plan.audioSourceDurationSeconds).toFixed(3);
    const audioFadeStart = Math.max(
      0,
      plan.audioSourceDurationSeconds - Number(audioFadeDuration),
    ).toFixed(3);
    const filter = [
      `[2:v]scale=${footerLogoWidth}:-1[footerLogo];`,
      `[0:v]trim=duration=${content},setpts=PTS-STARTPTS,`,
      `drawbox=x=0:y=ih-${footerHeight}:w=iw:h=${footerHeight}:color=0xF7F3EE@0.97:t=fill[contentClean];`,
      `[contentClean][footerLogo]overlay=x=W-w-8:y=H-h-2[contentBranded];`,
      `[1:v]scale=${width}:${height},format=rgba,`,
      `fade=t=in:st=0:d=${transition}:alpha=1,setpts=PTS+${transitionStart}/TB[card];`,
      `[contentBranded]tpad=stop_mode=clone:stop_duration=${plan.endCardDurationSeconds}[base];`,
      `[base][card]overlay=x=0:y=0:eof_action=pass:shortest=0[v];`,
      `[0:a]atrim=duration=${audioSource},asetpts=PTS-STARTPTS,`,
      `afade=t=out:st=${audioFadeStart}:d=${audioFadeDuration},`,
      `apad=whole_dur=${total}[a]`,
    ].join("");

    await execFileAsync(ffmpeg, [
      "-y",
      "-i", inputPath,
      "-loop", "1", "-i", cardPath,
      "-loop", "1", "-i", NUGLET_LOGO,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",
      "-t", total,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath,
    ], { timeout: 600_000, maxBuffer: 20 * 1024 * 1024 });
    const renderedBytes = await readFile(outputPath);
    const metadata = await videoMetadata(outputPath, ffprobe);
    const [backgroundBytes, logoBytes] = await Promise.all([
      readFile(END_CARD_BACKGROUND),
      readFile(NUGLET_LOGO),
    ]);
    return {
      bytes: renderedBytes,
      metadata,
      providerDurationSeconds: plan.providerDurationSeconds,
      providerTailTrimSeconds: plan.providerTailSeconds,
      narrativeDurationSeconds: plan.contentDurationSeconds,
      audioSourceDurationSeconds: plan.audioSourceDurationSeconds,
      audioTailTrimSeconds: plan.audioTailTrimSeconds,
      endCardDurationSeconds: plan.endCardDurationSeconds,
      endCardTransitionSeconds: plan.endCardTransitionSeconds,
      endCardVoiceOverlapSeconds: plan.endCardVoiceOverlapSeconds,
      endCardVersion: PUBLIC_PREVIEW_END_CARD_VERSION,
      endCardBackgroundChecksum: checksum(backgroundBytes),
      endCardArtworkChecksum: options.endCardArtworkBytes
        ? checksum(options.endCardArtworkBytes)
        : null,
      logoChecksum: checksum(logoBytes),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function renderEndCard(path, options) {
  const [titleLines, support, cta, logo] = await Promise.all([
    Promise.all(options.titleLines.map((line) => textLayer(line, {
      width: options.width - 40,
      font: options.displayFont,
      fontSize: options.titleFontSize,
      color: "#161412",
      directory: options.directory,
      pangoView: options.pangoView,
    }))),
    textLayer("One useful idea. Put it to work today.", {
      width: options.width - 40,
      font: options.supportFont,
      fontSize: 25,
      color: "#52604F",
      directory: options.directory,
      pangoView: options.pangoView,
    }),
    textLayer("Open the full Nuglet", {
      width: options.width - 40,
      font: options.ctaFont,
      fontSize: 31,
      color: "#FFFFFF",
      directory: options.directory,
      pangoView: options.pangoView,
    }),
    sharp(NUGLET_LOGO).resize({ width: options.cardLogoWidth }).png().toBuffer(),
  ]);
  const titleOverlays = await Promise.all(titleLines.map((input, index) => centeredOverlay(
    input,
    options.width,
    options.titleY + index * Math.round(options.titleFontSize * 1.02),
  )));
  const supportOverlay = await centeredOverlay(support, options.width, options.supportY);
  const ctaOverlay = await centeredOverlay(cta, options.width, options.ctaY);
  const artworkOverlays = options.endCardArtworkBytes
    ? await personalizedArtworkOverlays(
        options.endCardArtworkBytes,
        options.width,
        options.height,
      )
    : [];
  await sharp(END_CARD_BACKGROUND)
    .resize(options.width, options.height, { fit: "fill" })
    .composite([
      ...artworkOverlays,
      ...titleOverlays,
      supportOverlay,
      ctaOverlay,
      { input: logo, left: Math.round((options.width - options.cardLogoWidth) / 2), top: options.logoY },
    ])
    .png()
    .toFile(path);
}

async function personalizedArtworkOverlays(bytes, canvasWidth, canvasHeight) {
  const artworkWidth = Math.round(canvasWidth * 0.76);
  const artworkHeight = Math.round(artworkWidth * 0.75);
  const matte = Math.max(8, Math.round(canvasWidth * 0.014));
  const frameWidth = artworkWidth + matte * 2;
  const frameHeight = artworkHeight + matte * 2;
  const frameLeft = Math.round((canvasWidth - frameWidth) / 2);
  const frameTop = Math.round(canvasHeight * 0.05);
  const coverHeight = Math.round(canvasHeight * 0.54);
  const cover = await sharp({
    create: {
      width: canvasWidth,
      height: coverHeight,
      channels: 4,
      background: { r: 247, g: 243, b: 238, alpha: 0.96 },
    },
  }).png().toBuffer();
  const artwork = await sharp(bytes)
    .resize(artworkWidth, artworkHeight, { fit: "cover", position: "centre" })
    .modulate({ brightness: 1.02, saturation: 0.88 })
    .png()
    .toBuffer();
  const framedArtwork = await sharp({
    create: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
      background: { r: 255, g: 253, b: 249, alpha: 1 },
    },
  }).composite([{ input: artwork, left: matte, top: matte }]).png().toBuffer();
  const shadow = await sharp({
    create: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
      background: { r: 35, g: 30, b: 24, alpha: 0.16 },
    },
  }).blur(Math.max(3, Math.round(canvasWidth * 0.012))).png().toBuffer();
  return [
    { input: cover, left: 0, top: 0 },
    { input: shadow, left: frameLeft + 5, top: frameTop + 8 },
    { input: framedArtwork, left: frameLeft, top: frameTop },
  ];
}

async function centeredOverlay(input, canvasWidth, top) {
  const metadata = await sharp(input).metadata();
  return {
    input,
    left: Math.max(0, Math.round((canvasWidth - Number(metadata.width)) / 2)),
    top,
  };
}

async function textLayer(text, options) {
  const identity = createHash("sha256")
    .update(`${options.font}:${options.fontSize}:${text}`)
    .digest("hex")
    .slice(0, 12);
  const pgmPath = join(options.directory, `text-${identity}.pgm`);
  await execFileAsync(options.pangoView, [
    "--backend=ft2",
    "--no-display",
    "--pixels",
    "--margin=0",
    `--font=${options.font} ${options.fontSize}`,
    `--text=${text}`,
    `--output=${pgmPath}`,
  ], {
    env: { ...process.env, FONTCONFIG_FILE },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const { width, height, pixels } = parsePgm(await readFile(pgmPath));
  const { red, green, blue } = hexColor(options.color);
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = red;
    rgba[offset + 1] = green;
    rgba[offset + 2] = blue;
    rgba[offset + 3] = 255 - pixels[index];
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize({ width: options.width, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function videoMetadata(path, ffprobe) {
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", path,
  ]);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    durationSeconds: Number(parsed.format?.duration),
    width: Number(video?.width),
    height: Number(video?.height),
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

function parsePgm(bytes) {
  let offset = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
    if (bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      continue;
    }
    const start = offset;
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
    tokens.push(bytes.subarray(start, offset).toString("ascii"));
  }
  while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
  const [magic, widthText, heightText, maximumText] = tokens;
  const width = Number(widthText);
  const height = Number(heightText);
  if (magic !== "P5" || Number(maximumText) !== 255
    || !Number.isInteger(width) || width <= 0
    || !Number.isInteger(height) || height <= 0) {
    throw new Error("pango-view returned an invalid public preview text mask");
  }
  const pixels = bytes.subarray(offset);
  if (pixels.length !== width * height) {
    throw new Error("pango-view public preview text mask has an invalid byte length");
  }
  return { width, height, pixels };
}

function hexColor(value) {
  const match = String(value).match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
  if (!match) throw new Error(`invalid public preview text color: ${value}`);
  return {
    red: Number.parseInt(match[1], 16),
    green: Number.parseInt(match[2], 16),
    blue: Number.parseInt(match[3], 16),
  };
}
