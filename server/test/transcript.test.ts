import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseTranscript } from '../src/ingest/transcript.js';

function withFile<T>(contents: string, extension: string, fn: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-transcript-'));
  const file = path.join(dir, `transcript${extension}`);
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('VTT cues are parsed with their start times', () => {
  const vtt = `WEBVTT

00:00:05.000 --> 00:00:12.400
The resting membrane potential is about minus seventy millivolts.

00:00:12.400 --> 00:00:19.000
It is established by the sodium potassium ATPase.
`;

  const result = withFile(vtt, '.vtt', parseTranscript);

  assert.equal(result.blocks.length, 1, 'nearby cues merge into one block');
  assert.equal(result.blocks[0]?.timestamp, 5);
  assert.match(result.blocks[0]!.text, /minus seventy millivolts/);
  assert.match(result.blocks[0]!.text, /sodium potassium ATPase/);
});

test('a long silence starts a new block rather than backdating the material', () => {
  const vtt = `WEBVTT

00:00:05.000 --> 00:00:10.000
Early material about the resting potential.

00:34:20.100 --> 00:34:29.500
Much later material about saltatory conduction.
`;

  const result = withFile(vtt, '.vtt', parseTranscript);

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0]?.timestamp, 5);
  assert.equal(Math.round(result.blocks[1]!.timestamp!), 2060);
  assert.doesNotMatch(result.blocks[0]!.text, /saltatory/);
});

test('SRT comma-separated milliseconds and hour offsets are understood', () => {
  const srt = `1
00:01:02,500 --> 00:01:07,000
First line.

2
01:00:00,000 --> 01:00:04,000
An hour in.
`;

  const result = withFile(srt, '.srt', parseTranscript);

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0]?.timestamp, 62.5);
  assert.equal(result.blocks[1]?.timestamp, 3600);
});

test('plain text without timestamps still ingests, as paragraphs', () => {
  const text = 'First paragraph about the cortex.\n\nSecond paragraph about the thalamus.';
  const result = withFile(text, '.txt', parseTranscript);

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0]?.timestamp, undefined);
  assert.equal(result.warnings.length, 0);
});

test('inline markup and repeated rolling captions are cleaned up', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Lecturer>The <b>axon</b> hillock.

00:00:03.000 --> 00:00:05.000
The axon hillock.
`;

  const result = withFile(vtt, '.vtt', parseTranscript);

  assert.equal(result.blocks.length, 1);
  assert.doesNotMatch(result.blocks[0]!.text, /<[^>]+>/, 'tags should be stripped');
  const occurrences = result.blocks[0]!.text.match(/axon hillock/g) ?? [];
  assert.equal(occurrences.length, 1, 'a repeated rolling caption should collapse');
});
