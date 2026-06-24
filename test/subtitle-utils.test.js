const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const Core = require("../src/shared.js");

test("parseJson3Captions extracts YouTube json3 events", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "captions.json"), "utf8")
  );

  const cues = Core.parseJson3Captions(fixture);
  assert.equal(cues.length, 4);
  assert.deepEqual(cues[0], {
    startMs: 0,
    endMs: 900,
    sourceText: "Hello"
  });
  assert.equal(cues[3].sourceText, "a test & demo");
});

test("parseVttCaptions handles cue ids, settings, and HTML cleanup", () => {
  const cues = Core.parseVttCaptions(`
WEBVTT

1
00:00:01.000 --> 00:00:02.500 align:start
<c>Hello</c> &amp; welcome

00:00:03.000 --> 00:00:04.000
Next line
`);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[0].sourceText, "Hello & welcome");
});

test("parseXmlCaptions handles transcript text captions", () => {
  const cues = Core.parseXmlCaptions(`
<transcript>
  <text start="1.25" dur="2.5">Hello &amp; welcome</text>
  <text start="4" dur="1">Next line</text>
</transcript>
`);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1250);
  assert.equal(cues[0].endMs, 3750);
  assert.equal(cues[0].sourceText, "Hello & welcome");
});

test("parseXmlCaptions handles srv3 paragraph captions", () => {
  const cues = Core.parseXmlCaptions(`
<timedtext>
  <body>
    <p t="1000" d="2500"><s>Hello</s><s> world.</s></p>
  </body>
</timedtext>
`);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[0].sourceText, "Hello world.");
});

test("parseXmlCaptions handles ttml begin and end times", () => {
  const cues = Core.parseXmlCaptions(`
<tt>
  <body>
    <div>
      <p begin="00:00:02.000" end="00:00:03.500">Timed text</p>
    </div>
  </body>
</tt>
`);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 2000);
  assert.equal(cues[0].endMs, 3500);
});

test("parseYouTubeTranscriptResponse extracts transcript segments", () => {
  const cues = Core.parseYouTubeTranscriptResponse({
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        {
                          transcriptSegmentRenderer: {
                            startMs: "1000",
                            endMs: "2500",
                            snippet: {
                              runs: [{ text: "Hello" }, { text: " world." }]
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    ]
  });

  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[0].sourceText, "Hello world.");
});

test("findYouTubeTranscriptParams locates nested transcript endpoint params", () => {
  const params = Core.findYouTubeTranscriptParams(
    {
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            content: {
              continuationItemRenderer: {
                continuationEndpoint: {
                  getTranscriptEndpoint: {
                    params: "abc123"
                  }
                }
              }
            }
          }
        }
      ]
    },
    0
  );

  assert.equal(params, "abc123");
});

test("mergeCaptionFragments combines small fragments into sentence cues", () => {
  const raw = [
    { startMs: 0, endMs: 500, sourceText: "Hello" },
    { startMs: 650, endMs: 1000, sourceText: "world." },
    { startMs: 1100, endMs: 1500, sourceText: "New" },
    { startMs: 1700, endMs: 2100, sourceText: "idea" }
  ];

  const merged = Core.mergeCaptionFragments(raw);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].sourceText, "Hello world.");
  assert.equal(merged[1].sourceText, "New idea");
  assert.equal(merged[0].id, "0");
  assert.equal(merged[1].id, "1");
});

test("mergeCaptionFragments breaks on long gaps", () => {
  const raw = [
    { startMs: 0, endMs: 500, sourceText: "Alpha" },
    { startMs: 2000, endMs: 2500, sourceText: "Beta" }
  ];

  const merged = Core.mergeCaptionFragments(raw);
  assert.equal(merged.length, 2);
});

test("findCueAtTime returns the active cue by binary search", () => {
  const cues = [
    { startMs: 0, endMs: 1000, sourceText: "A" },
    { startMs: 2000, endMs: 3000, sourceText: "B" }
  ];

  assert.equal(Core.findCueAtTime(cues, 2500).sourceText, "B");
  assert.equal(Core.findCueAtTime(cues, 1500), null);
});

test("parseDeepSeekTranslationContent accepts common JSON shapes", () => {
  assert.deepEqual(
    Core.parseDeepSeekTranslationContent('{"items":[{"id":"1","translatedText":"你好"}]}'),
    [{ id: "1", translatedText: "你好" }]
  );
  assert.deepEqual(Core.parseDeepSeekTranslationContent('{"2":"世界"}'), [
    { id: "2", translatedText: "世界" }
  ]);
});

test("cache keys are stable and namespaced", () => {
  const key = Core.makeCacheKey(["video", "track", "model"]);
  assert.match(key, /^ytbt:/);
  assert.equal(key, Core.makeCacheKey(["video", "track", "model"]));
});

test("resolveTranslationConfig keeps old DeepSeek API key compatible", () => {
  const config = Core.resolveTranslationConfig({
    deepseekApiKey: "old-key"
  });

  assert.equal(config.provider, "deepseek");
  assert.equal(config.apiKey, "old-key");
  assert.equal(config.model, Core.DEEPSEEK_MODEL);
  assert.equal(config.chatCompletionsUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(config.includeDeepSeekThinkingFlag, true);
});

test("resolveTranslationConfig supports custom OpenAI-compatible API", () => {
  const config = Core.resolveTranslationConfig({
    translationProvider: "custom",
    translationApiKey: "custom-key",
    translationBaseUrl: "https://api.example.com/v1/",
    translationModel: "custom-model",
    translationJsonResponse: false
  });

  assert.equal(config.provider, "custom");
  assert.equal(config.apiKey, "custom-key");
  assert.equal(config.model, "custom-model");
  assert.equal(config.chatCompletionsUrl, "https://api.example.com/v1/chat/completions");
  assert.equal(config.useJsonResponseFormat, false);
  assert.equal(config.includeDeepSeekThinkingFlag, false);
});

test("buildChatCompletionsUrl accepts full endpoint URLs", () => {
  assert.equal(
    Core.buildChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  );
});
