import { nanoid } from "nanoid";

import type { DramaAssetProfile, DramaContentAnalysis, DramaShotContinuity, DramaUtterance, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import { resolveDramaShotDuration, resolveDramaShotDurations, type DramaShotDurationPolicy } from "@/lib/server/drama-shot-config";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";

export function normalizeDramaContentAnalysis(value: unknown, durationPolicy: number | DramaShotDurationPolicy, sourceScript = ""): DramaContentAnalysis {
    const source = object(value);
    const sourceCharacterNames = array(source.characters)
        .map((item) => text(object(item).name))
        .filter(Boolean);
    const rawShots = array(source.shots).flatMap((item, index) => {
        const shot = object(item);
        const sourceText = text(shot.sourceText);
        const title = text(shot.title) || `镜头 ${String(index + 1).padStart(2, "0")}`;
        const description = text(shot.description) || sourceText || title;
        if (!sourceText && !sourceScript) return [];
        const modelUtterances = array(shot.utterances).flatMap((value, utteranceIndex) => {
            const utterance = object(value);
            const utteranceText = text(utterance.text);
            if (!utteranceText) return [];
            return [
                {
                    id: `utterance-${nanoid()}`,
                    order: utteranceIndex + 1,
                    type: utterance.type === "voiceover" ? ("voiceover" as const) : ("dialogue" as const),
                    speaker: text(utterance.speaker),
                    text: utteranceText,
                },
            ];
        });
        const characterNames = texts(shot.characterNames);
        const mergedUtterances = mergeUtterances(extractDramaUtterances(sourceText, [...new Set([...characterNames, ...sourceCharacterNames])]), modelUtterances);
        const dialogue = normalizeDialogue(sourceScript ? "" : extractQuotedDialogue(sourceText) || shot.dialogue, mergedUtterances);
        const narration =
            text(shot.narration) ||
            mergedUtterances
                .filter((item) => item.type === "voiceover")
                .map((item) => item.text)
                .join("\n");
        const utterances = ensureUtteranceCoverage(mergedUtterances, dialogue, narration);
        return [
            {
                title,
                description,
                sourceText,
                shotBoundary: text(shot.shotBoundary) || "动作或叙事节拍变化",
                dialogue,
                narration,
                utterances,
                duration: resolveDramaShotDuration(shot.duration, dramaDefaultDuration(durationPolicy)),
                characterNames,
                sceneName: text(shot.sceneName),
                propNames: texts(shot.propNames),
                clueNames: texts(shot.clueNames),
            },
        ];
    });
    const coveredShots = restoreMissingDialogueCoverage(restoreSourceTextCoverage(rawShots, sourceScript), sourceScript, sourceCharacterNames);
    const shots = coveredShots.flatMap((shot) => splitDramaContentShot(shot, resolveDramaShotDurations(Math.max(shot.duration, estimateDramaSpokenDuration(shot)), durationPolicy)));
    return {
        episode: {
            outline: text(object(source.episode).outline),
            hook: text(object(source.episode).hook),
            nextPreview: text(object(source.episode).nextPreview),
            sourceRange: text(object(source.episode).sourceRange),
        },
        characters: normalizeAssets(source.characters),
        scenes: normalizeAssets(source.scenes),
        props: normalizeAssets(source.props),
        clues: normalizeClues(source.clues),
        shots,
    };
}

function dramaDefaultDuration(policy: number | DramaShotDurationPolicy) {
    return typeof policy === "number" ? policy : policy.defaultSeconds;
}

function restoreSourceTextCoverage(shots: DramaContentAnalysis["shots"], sourceScript: string) {
    const script = sourceScript.trim();
    if (!script || !shots.length) return shots;
    if (shots.length === 1) return [{ ...shots[0], sourceText: script }];
    if (script.length < shots.length) return shots;

    const positions = locateShotPositions(script, shots);
    const preferredCuts = Array.from(script.matchAll(/[。！？!?；;\n][”"」』]?/gu), (match) => (match.index || 0) + match[0].length);
    const cuts = [0];
    for (let index = 1; index < shots.length; index += 1) {
        const minimum = cuts[index - 1] + 1;
        const maximum = script.length - (shots.length - index);
        const proportional = Math.round((script.length * index) / shots.length);
        const located = positions[index];
        const target = located >= minimum && located <= maximum ? located : Math.max(minimum, Math.min(maximum, proportional));
        const preferred = preferredCuts.filter((cut) => cut >= minimum && cut <= maximum).sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0];
        cuts.push(preferred ?? target);
    }
    cuts.push(script.length);
    return shots.map((shot, index) => ({
        ...shot,
        sourceText: script.slice(cuts[index], cuts[index + 1]).trim() || shot.sourceText,
    }));
}

function estimateDramaSpokenDuration(shot: DramaContentAnalysis["shots"][number]) {
    const utteranceText = shot.utterances.map((item) => item.text.trim()).filter(Boolean);
    const spokenText = utteranceText.length
        ? utteranceText
        : [shot.dialogue, shot.narration]
              .flatMap((value) => value.split(/\n+/))
              .map((value) => value.trim())
              .filter(Boolean);
    const seconds = spokenText.reduce((total, value) => {
        const cjkCharacters = value.match(/\p{Script=Han}/gu)?.length || 0;
        const words = value.replace(/\p{Script=Han}/gu, " ").match(/[\p{Letter}\p{Number}]+/gu)?.length || 0;
        return total + cjkCharacters / 4 + words / 2.5;
    }, 0);
    return Math.max(1, Math.ceil(seconds));
}

function splitDramaContentShot(shot: DramaContentAnalysis["shots"][number], durations: number[]) {
    if (durations.length <= 1) return [{ ...shot, duration: durations[0] }];
    const sourceChunks = splitContinuousSourceText(shot.sourceText, durations);
    const utteranceChunks = distributeUtterances(shot.utterances, sourceChunks);
    return durations.map((duration, index) => {
        const utterances = utteranceChunks[index].map((utterance, utteranceIndex) => ({ ...utterance, order: utteranceIndex + 1 }));
        return {
            ...shot,
            title: `${shot.title}（${index + 1}/${durations.length}）`,
            description: sourceChunks[index] || shot.description,
            sourceText: sourceChunks[index],
            dialogue: utterances
                .filter((item) => item.type === "dialogue")
                .map((item) => item.text)
                .join("\n"),
            narration: utterances
                .filter((item) => item.type === "voiceover")
                .map((item) => item.text)
                .join("\n"),
            utterances,
            duration,
        };
    });
}

function splitContinuousSourceText(value: string, durations: number[]) {
    const characters = Array.from(value);
    if (durations.length <= 1 || characters.length <= 1) return [value, ...Array.from({ length: Math.max(0, durations.length - 1) }, () => "")];
    const preferredCuts = new Set<number>();
    characters.forEach((character, index) => {
        if (/[。！？!?；;\n]/u.test(character)) preferredCuts.add(/[”"」』]/u.test(characters[index + 1] || "") ? index + 2 : index + 1);
    });
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    const cuts = [0];
    let elapsed = 0;
    for (let index = 0; index < durations.length - 1; index += 1) {
        elapsed += durations[index];
        const minimum = Math.min(characters.length, cuts[index] + 1);
        const maximum = Math.max(minimum, characters.length - (durations.length - index - 1));
        const target = Math.max(minimum, Math.min(maximum, Math.round((characters.length * elapsed) / totalDuration)));
        const preferred = [...preferredCuts].filter((cut) => cut >= minimum && cut <= maximum).sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0];
        cuts.push(preferred ?? target);
    }
    cuts.push(characters.length);
    return durations.map((_, index) =>
        characters
            .slice(cuts[index], cuts[index + 1])
            .join("")
            .trim(),
    );
}

function distributeUtterances(utterances: DramaUtterance[], sourceChunks: string[]) {
    const chunks = sourceChunks.map(() => [] as DramaUtterance[]);
    let cursor = 0;
    utterances.forEach((utterance, utteranceIndex) => {
        const key = dialogueKey(utterance.text);
        const matchedIndex = sourceChunks.findIndex((chunk, index) => index >= cursor && key && dialogueKey(chunk).includes(key));
        const proportionalIndex = Math.min(sourceChunks.length - 1, Math.floor((utteranceIndex * sourceChunks.length) / Math.max(1, utterances.length)));
        const targetIndex = matchedIndex >= 0 ? matchedIndex : Math.max(cursor, proportionalIndex);
        chunks[targetIndex].push(utterance);
        cursor = targetIndex;
    });
    return chunks;
}

function ensureUtteranceCoverage(utterances: DramaUtterance[], dialogue: string, narration: string) {
    const result = [...utterances];
    for (const [type, value] of [
        ["dialogue", dialogue],
        ["voiceover", narration],
    ] as const) {
        for (const line of value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)) {
            if (result.some((item) => item.type === type && sameDialogue(item.text, line))) continue;
            result.push({ id: `utterance-${nanoid()}`, order: result.length + 1, type, speaker: "", text: line });
        }
    }
    return result.map((item, index) => ({ ...item, order: index + 1 }));
}

export function normalizeDramaVisualAnalysis(value: unknown, shotIds: string[]): DramaVisualAnalysis {
    const allowed = new Set(shotIds);
    const seen = new Set<string>();
    const shots = array(object(value).shots).flatMap((item) => {
        const shot = object(item);
        const shotId = text(shot.shotId);
        const imagePrompt = text(shot.imagePrompt);
        const videoPrompt = text(shot.videoPrompt);
        if (!allowed.has(shotId) || seen.has(shotId) || !imagePrompt || !videoPrompt) return [];
        seen.add(shotId);
        return [
            {
                shotId,
                imagePrompt,
                videoPrompt,
                cameraMotion: text(shot.cameraMotion),
                startFramePrompt: text(shot.startFramePrompt) || imagePrompt,
                endFramePrompt: text(shot.endFramePrompt) || videoPrompt,
                negativePrompt: text(shot.negativePrompt),
                continuity: normalizeContinuity(shot.continuity),
            },
        ];
    });
    return { shots };
}

export function readDramaUpstreamError(value: string, status: number) {
    const fallback = status === 401 || status === 403 ? "文本模型渠道鉴权失败，请管理员检查账号和密钥" : status === 429 ? "文本模型渠道请求过于频繁，请稍后重试" : status >= 500 ? `文本模型渠道暂不可用（HTTP ${status}）` : "后台文本模型调用失败";
    if (!value.trim()) return fallback;
    try {
        const payload = JSON.parse(value) as { msg?: unknown; error?: unknown; response?: unknown };
        const error = object(payload.error);
        const responseError = object(object(payload.response).error);
        return text(payload.msg, 300) || text(payload.error, 300) || text(error.message, 300) || text(responseError.message, 300) || fallback;
    } catch {
        return value.trim().slice(0, 300) || fallback;
    }
}

export function readDramaResponsesArguments(value: unknown, toolName: string) {
    const source = object(value);
    const direct = strictJsonObjectText(source.output_text);
    if (direct) return direct;
    const output = array(source.output);
    const call = output.map(object).find((item) => item.type === "function_call" && item.name === toolName);
    const argumentsText = jsonObjectArguments(call?.arguments);
    if (argumentsText) return argumentsText;
    for (const item of output.map(object)) {
        const itemText = strictJsonObjectText(item.text);
        if (itemText) return itemText;
        for (const content of array(item.content).map(object)) {
            const text = strictJsonObjectText(content.text);
            if (text) return text;
        }
    }
    return "";
}

export function readDramaChatArguments(value: unknown, toolName: string) {
    for (const choice of array(object(value).choices).map(object)) {
        const message = object(choice.message);
        const call = array(message.tool_calls)
            .map(object)
            .map((item) => object(item.function))
            .find((item) => item.name === toolName);
        const legacyCall = object(message.function_call);
        const argumentsText = jsonObjectArguments(call?.arguments) || (legacyCall.name === toolName ? jsonObjectArguments(legacyCall.arguments) : "");
        if (argumentsText) return argumentsText;
        const content = strictJsonObjectText(message.content);
        if (content) return content;
        for (const item of array(message.content).map(object)) {
            const itemText = strictJsonObjectText(item.text);
            if (itemText) return itemText;
        }
    }
    return "";
}

export function hasUsableDramaToolArguments(value: string, toolName: string) {
    try {
        const source = object(JSON.parse(value));
        if ("script" in source || "summary" in source) return false;
        const shots = array(source.shots).map(object);
        if (!shots.length) return false;
        return toolName !== "analyze_drama_content" || shots.some((shot) => text(shot.title) || text(shot.description) || text(shot.sourceText) || array(shot.utterances).length);
    } catch {
        return false;
    }
}

/**
 * Some Responses-compatible gateways wrap the JSON object one more time even
 * when the model returned the requested structured payload. Unwrap only the
 * documented result containers and keep the domain validator as the final gate.
 */
export function normalizeDramaToolArguments(value: string, toolName: string) {
    let current: unknown = value;
    for (let depth = 0; depth < 4; depth += 1) {
        if (typeof current === "string") {
            try {
                current = JSON.parse(current);
            } catch {
                return value;
            }
        }
        const source = object(current);
        if (Array.isArray(source.shots)) return JSON.stringify(source);
        const wrapped = [source[toolName], source.arguments, source.result, source.data, source.response].find((item) => item !== undefined);
        if (wrapped === undefined) return value;
        current = wrapped;
    }
    return value;
}

export function hasCompleteDramaDialogueAttribution(value: string, sourceScript: string) {
    try {
        const source = object(JSON.parse(value));
        const shots = array(source.shots).map(object);
        const knownSpeakers = [...array(source.characters).map((item) => text(object(item).name)), ...shots.flatMap((shot) => texts(shot.characterNames))].filter(Boolean);
        const sourceDialogue = extractDialogueSpans(sourceScript, knownSpeakers);
        const modelDialogue = shots.flatMap((shot) =>
            array(shot.utterances)
                .map(object)
                .filter((utterance) => utterance.type === "dialogue"),
        );
        if (modelDialogue.some((utterance) => !text(utterance.text))) return false;
        if (modelDialogue.some((utterance) => !sourceDialogue.some((span) => sameDialogue(span.text, text(utterance.text))))) return false;
        const remaining = [...modelDialogue];
        return sourceDialogue.every((span) => {
            const index = remaining.findIndex((utterance) => sameDialogue(span.text, text(utterance.text)));
            if (index < 0) return false;
            remaining.splice(index, 1);
            return true;
        });
    } catch {
        return false;
    }
}

export function hasCompleteDramaContentAnalysis(value: DramaContentAnalysis, sourceScript: string) {
    const source = sourceScript.trim().replace(/\s/gu, "");
    const covered = value.shots
        .map((shot) => shot.sourceText)
        .join("")
        .replace(/\s/gu, "");
    return Boolean(source && value.shots.length && covered === source && hasCompleteDramaDialogueAttribution(JSON.stringify(value), sourceScript));
}

function isSpecificDramaSpeaker(value: string) {
    return Boolean(value && !/^(?:说话人|未知|不明|不详|角色|人物|他|她|其)$/u.test(value));
}

export function describeDramaModelOutput(value: unknown) {
    const source = object(value);
    return {
        topLevelKeys: Object.keys(source).slice(0, 12),
        outputTextType: valueType(source.output_text),
        output: array(source.output)
            .slice(0, 10)
            .map((value) => {
                const item = object(value);
                return {
                    type: text(item.type, 40),
                    name: text(item.name, 80),
                    argumentsType: valueType(item.arguments),
                    contentTypes: array(item.content)
                        .slice(0, 10)
                        .map((content) => text(object(content).type, 40) || valueType(content)),
                };
            }),
        choices: array(source.choices)
            .slice(0, 3)
            .map((value) => {
                const message = object(object(value).message);
                return {
                    contentType: valueType(message.content),
                    toolCallCount: array(message.tool_calls).length,
                    toolNames: array(message.tool_calls)
                        .slice(0, 10)
                        .map((toolCall) => text(object(object(toolCall).function).name, 80))
                        .filter(Boolean),
                    functionCallName: text(object(message.function_call).name, 80),
                };
            }),
    };
}

export function describeDramaAnalysisCandidate(value: unknown) {
    const source = object(value);
    return {
        topLevelKeys: Object.keys(source).slice(0, 20),
        episodeKeys: Object.keys(object(source.episode)).slice(0, 20),
        counts: {
            characters: array(source.characters).length,
            scenes: array(source.scenes).length,
            props: array(source.props).length,
            clues: array(source.clues).length,
            shots: array(source.shots).length,
        },
        shots: array(source.shots)
            .slice(0, 5)
            .map((value) => {
                const shot = object(value);
                return {
                    keys: Object.keys(shot).slice(0, 24),
                    titleType: valueType(shot.title),
                    descriptionType: valueType(shot.description),
                    sourceTextType: valueType(shot.sourceText),
                    utterancesType: valueType(shot.utterances),
                    durationType: valueType(shot.duration),
                };
            }),
    };
}

function jsonObjectArguments(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}

function valueType(value: unknown) {
    return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function normalizeAssets(value: unknown) {
    return array(value).flatMap((item) => {
        const record = object(item);
        const name = text(record.name);
        return name
            ? [
                  {
                      name,
                      description: text(record.description),
                      profile: normalizeProfile(record.profile, record),
                  },
              ]
            : [];
    });
}

function normalizeClues(value: unknown) {
    return array(value).flatMap((item) => {
        const record = object(item);
        const name = text(record.name);
        return name
            ? [
                  {
                      name,
                      description: text(record.description),
                      profile: normalizeProfile(record.profile, record),
                      payoff: text(record.payoff),
                  },
              ]
            : [];
    });
}

function normalizeProfile(value: unknown, fallback: Record<string, unknown>): DramaAssetProfile {
    const profile = object(value);
    return {
        visualIdentity: text(profile.visualIdentity) || text(fallback.visualIdentity),
        styling: text(profile.styling) || text(fallback.styling),
        colorPalette: text(profile.colorPalette) || text(fallback.colorPalette),
        consistencyRules: text(profile.consistencyRules) || text(fallback.consistencyRules),
    };
}

function normalizeContinuity(value: unknown): DramaShotContinuity {
    const input = object(value);
    return {
        shotSize: text(input.shotSize),
        cameraAngle: text(input.cameraAngle),
        composition: text(input.composition),
        characterBlocking: text(input.characterBlocking),
        gazeDirection: text(input.gazeDirection),
        actionStart: text(input.actionStart),
        actionEnd: text(input.actionEnd),
        screenDirection: text(input.screenDirection),
        axisRule: text(input.axisRule),
        continuityNotes: text(input.continuityNotes),
    };
}

type DialogueSpan = {
    start: number;
    end: number;
    speaker: string;
    text: string;
};

const narrativeDialoguePattern = /^[^。！？!?]{0,24}(?:说明|表示|告知|询问|讲述|描述|解释|透露|提到|认为|发现|来到|进入|看见|感到|回忆|想起|请求|劝说)(?:自己|对方|她|他|其|，|,)/u;
const speechVerbPattern = /(?:说|说道|讲|讲道|告诉|问|问道|回答|答道|开口|喊|叫|嚷|嚷道|低声道|轻声道|呢喃|念叨|嘀咕|回应|回道|回了?一句|应道|接话|追问|反问|提醒|安慰|解释道|补充道|笑道|哭道|吼道|骂道|想说)\s*$/u;

function extractQuotedDialogue(value: string) {
    return extractDialogueSpans(value)
        .map((item) => item.text)
        .join("\n");
}

function normalizeDialogue(value: unknown, utterances: DramaUtterance[]) {
    const direct = text(value);
    const utteranceText = utterances
        .filter((item) => item.type === "dialogue" && !narrativeDialoguePattern.test(item.text))
        .map((item) => item.text)
        .join("\n");
    return utteranceText || (direct && !narrativeDialoguePattern.test(direct) ? direct : "");
}

function extractDramaUtterances(value: string, knownSpeakers: string[]): DramaUtterance[] {
    return extractDialogueSpans(value, knownSpeakers).map((item, index) => ({
        id: `utterance-${nanoid()}`,
        order: index + 1,
        type: "dialogue",
        speaker: item.speaker,
        text: item.text,
    }));
}

function extractDialogueSpans(value: string, knownSpeakers: string[] = []): DialogueSpan[] {
    const spans: DialogueSpan[] = [];
    const seen = new Set<string>();
    const quotePattern = /“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"\r\n]+)"/g;
    for (const match of value.matchAll(quotePattern)) {
        const dialogue = [match[1], match[2], match[3], match[4]].find(Boolean)?.trim() || "";
        if (!dialogue) continue;
        const start = match.index || 0;
        const end = start + match[0].length;
        const before = value.slice(Math.max(0, start - 80), start);
        const after = value.slice(end, Math.min(value.length, end + 80));
        const speaker = inferDialogueSpeaker(before, after, knownSpeakers);
        if (!speaker && !looksLikeSpokenQuote(dialogue, before)) continue;
        addDialogueSpan(spans, seen, { start, end, speaker, text: dialogue });
    }
    let lineStart = 0;
    for (const line of value.split("\n")) {
        for (const match of line.matchAll(/[：:]/g)) {
            const colonIndex = match.index || 0;
            const before = line.slice(0, colonIndex).trimEnd().slice(-60);
            const after = line.slice(colonIndex + 1).trim();
            if (!speechVerbPattern.test(before) || !after || /^[“"「『]/.test(after)) continue;
            addDialogueSpan(spans, seen, {
                start: lineStart + colonIndex + 1,
                end: lineStart + line.length,
                speaker: inferSpeaker(before, knownSpeakers),
                text: after,
            });
        }
        lineStart += line.length + 1;
    }
    return spans.sort((left, right) => left.start - right.start);
}

function addDialogueSpan(spans: DialogueSpan[], seen: Set<string>, span: DialogueSpan) {
    const key = dialogueKey(span.text);
    const occurrenceKey = `${span.start}:${key}`;
    if (!key || seen.has(occurrenceKey)) return;
    seen.add(occurrenceKey);
    spans.push(span);
}

function inferDialogueSpeaker(before: string, after: string, knownSpeakers: string[]) {
    return inferSpeaker(before, knownSpeakers) || inferFollowingSpeaker(after, knownSpeakers);
}

function inferSpeaker(value: string, knownSpeakers: string[] = []) {
    const sentences = value
        .split(/[。！？!?；;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    const sentence = sentences.at(-1) || "";
    if (/(?:名字|姓名|称呼|人称)\s*叫\s*$/u.test(sentence)) return "";
    const verbMatch = sentence.match(/(?:说|说道|讲|讲道|告诉|问|问道|回答|答道|开口|喊|叫|嚷|嚷道|低声道|轻声道|呢喃|念叨|嘀咕|回应|回道|回了?一句|应道|接话|追问|反问|提醒|安慰|解释道|补充道|笑道|哭道|吼道|骂道|想说)\s*[：:]?\s*$/u);
    if (!verbMatch?.index) return "";
    const subject = sentence
        .slice(0, verbMatch.index)
        .replace(/(?:又|再|再次|缓缓|轻轻|低声|轻声|小声|忍不住|刚想|终于|随即|立即|赶紧|回了?一句)+$/u, "")
        .trim();
    const speakerSubject = subject.replace(/[，,]?(?:对|向|冲|朝|跟)(?:着)?[^，,。！？!?；;]{0,24}$/u, "").trim();
    const compactSubject = speakerSubject.split(/[，,]/).pop()?.trim().replace(/^.*的/u, "") || "";
    const knownSpeaker = nearestKnownSpeaker(compactSubject, knownSpeakers) || leadingKnownSpeaker(speakerSubject, knownSpeakers) || firstKnownSpeaker(speakerSubject, knownSpeakers);
    if (knownSpeaker) return knownSpeaker;
    if (/^(?:对|向|冲|朝|跟)(?:着)?/u.test(subject)) {
        const previousSentence = sentences.at(-2) || "";
        const previousSpeaker = leadingKnownSpeaker(previousSentence, knownSpeakers) || firstKnownSpeaker(previousSentence, knownSpeakers) || leadingNarrativeSpeaker(previousSentence);
        if (previousSpeaker) return previousSpeaker;
    }
    const leadingSpeaker = leadingNarrativeSpeaker(compactSubject);
    if (leadingSpeaker) return leadingSpeaker;
    return compactSubject.match(/[\p{Script=Han}A-Za-z0-9·]{1,12}$/u)?.[0] || "";
}

function leadingNarrativeSpeaker(value: string) {
    return value.match(/(?:^|[，,])\s*[”"」』]?(他|她|男人|女人|老人|女孩|男孩|医生|护士|[\p{Script=Han}]{2,4}?)(?=闭|睁|抬|低|看|走|站|坐|转|笑|哭|皱|摇|点|伸|捂|扶|推|拉|拿|压|咬|忍|哼|喘|叹|惊|快|刚|又|再|缓|轻|小|随|立|赶)/u)?.[1] || "";
}

function leadingKnownSpeaker(value: string, knownSpeakers: string[]) {
    return [...knownSpeakers]
        .sort((left, right) => right.length - left.length)
        .find((name) => {
            const index = value.indexOf(name);
            return index >= 0 && index <= 2;
        });
}

function firstKnownSpeaker(value: string, knownSpeakers: string[]) {
    return knownSpeakers.reduce<{ name: string; index: number } | undefined>((first, name) => {
        const index = value.indexOf(name);
        return index >= 0 && (!first || index < first.index) ? { name, index } : first;
    }, undefined)?.name;
}

function inferFollowingSpeaker(value: string, knownSpeakers: string[]) {
    const sentence =
        value
            .split(/[。！？!?；;\n]/)[0]
            ?.trim()
            .replace(/^[，,]/u, "") || "";
    if (!speechVerbPattern.test(sentence) && !/(?:说|道|问|答|喊|叫|回应|回道|应道|笑道|哭道|吼道|骂道|闷哼|呻吟|惊呼)/u.test(sentence)) return "";
    const knownSpeaker = nearestKnownSpeaker(sentence, knownSpeakers);
    if (knownSpeaker) return knownSpeaker;
    return sentence.match(/^(他|她|男人|女人|老人|女孩|男孩|医生|护士|[\p{Script=Han}A-Za-z0-9·]{2,12}?)(?=\s*(?:低声|轻声|小声|淡淡|缓缓|冷冷|笑着|哭着|闷哼|呻吟|惊呼|说|道|问|答|喊|叫))/u)?.[1] || "";
}

function nearestKnownSpeaker(value: string, knownSpeakers: string[]) {
    return knownSpeakers.reduce<{ name: string; index: number } | undefined>((nearest, name) => {
        const index = value.lastIndexOf(name);
        return index >= 0 && (!nearest || index > nearest.index) ? { name, index } : nearest;
    }, undefined)?.name;
}

function looksLikeSpokenQuote(value: string, before: string) {
    return /[。！？!?…]$/u.test(value.trim()) || /[：:]\s*$/u.test(before);
}

function mergeUtterances(sourceUtterances: DramaUtterance[], modelUtterances: DramaUtterance[]) {
    return sourceUtterances.map((item, index) => {
        const model = modelUtterances.find((candidate) => sameDialogue(candidate.text, item.text));
        return { ...(model && isSpecificDramaSpeaker(model.speaker) ? { ...item, speaker: model.speaker } : item), order: index + 1 };
    });
}

function restoreMissingDialogueCoverage(shots: DramaContentAnalysis["shots"], sourceScript: string, characterNames: string[] = []) {
    const script = sourceScript.trim();
    if (!script || !shots.length) return shots;
    const covered = new Map<string, number>();
    for (const shot of shots) {
        const values = shot.utterances.filter((item) => item.type === "dialogue").map((item) => item.text);
        for (const value of values.length ? values : shot.dialogue.split("\n")) {
            const key = dialogueKey(value);
            if (key) covered.set(key, (covered.get(key) || 0) + 1);
        }
    }
    const matched = new Map<string, number>();
    const positions = locateShotPositions(script, shots);
    const result = shots.map((shot) => ({ ...shot, utterances: [...shot.utterances] }));
    const knownSpeakers = [...new Set([...characterNames, ...shots.flatMap((shot) => shot.characterNames)])];
    for (const span of extractDialogueSpans(script, knownSpeakers)) {
        const key = dialogueKey(span.text);
        if (!key) continue;
        const matchedCount = matched.get(key) || 0;
        if (matchedCount < (covered.get(key) || 0)) {
            fillMissingDialogueSpeaker(result, key, matchedCount, span.speaker);
            matched.set(key, matchedCount + 1);
            continue;
        }
        const targetIndex = nearestShotIndex(span.start, positions, result.length, script.length);
        const target = result[targetIndex];
        if (!target) continue;
        target.utterances.push({ id: `utterance-${nanoid()}`, order: target.utterances.length + 1, type: "dialogue", speaker: span.speaker, text: span.text });
        target.dialogue = target.utterances
            .filter((item) => item.type === "dialogue")
            .map((item) => item.text)
            .join("\n");
        matched.set(key, matchedCount + 1);
    }
    return result;
}

function fillMissingDialogueSpeaker(shots: DramaContentAnalysis["shots"], key: string, occurrence: number, speaker: string) {
    if (!speaker) return;
    let matched = 0;
    for (const shot of shots) {
        for (const utterance of shot.utterances) {
            if (utterance.type !== "dialogue" || dialogueKey(utterance.text) !== key) continue;
            if (matched === occurrence) {
                if (!utterance.speaker.trim()) utterance.speaker = speaker;
                return;
            }
            matched += 1;
        }
    }
}

function locateShotPositions(script: string, shots: DramaContentAnalysis["shots"]) {
    let cursor = 0;
    return shots.map((shot) => {
        const sourceText = shot.sourceText.trim();
        const candidates = [sourceText, sourceText.slice(0, 160), sourceText.slice(0, 80)].filter((value, index, values) => value.length >= 12 && values.indexOf(value) === index);
        let position = -1;
        for (const candidate of candidates) {
            position = script.indexOf(candidate, cursor);
            if (position < 0) position = script.indexOf(candidate);
            if (position >= 0) break;
        }
        if (position >= 0) cursor = position + Math.max(1, sourceText.length);
        return position;
    });
}

function nearestShotIndex(position: number, shotPositions: number[], shotCount: number, scriptLength: number) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    shotPositions.forEach((shotPosition, index) => {
        if (shotPosition < 0) return;
        const distance = Math.abs(position - shotPosition);
        if (distance < bestDistance) {
            bestIndex = index;
            bestDistance = distance;
        }
    });
    if (bestIndex >= 0) return bestIndex;
    return Math.min(shotCount - 1, Math.floor((position / Math.max(1, scriptLength)) * shotCount));
}

function sameDialogue(left: string, right: string) {
    const leftKey = dialogueKey(left);
    const rightKey = dialogueKey(right);
    return Boolean(leftKey && rightKey && (leftKey === rightKey || (Math.min(leftKey.length, rightKey.length) >= 4 && (leftKey.includes(rightKey) || rightKey.includes(leftKey)))));
}

function dialogueKey(value: string) {
    return value.toLocaleLowerCase().replace(/[\s“”"「」『』，。！？!?、：:；;…—-]/g, "");
}

function texts(value: unknown) {
    return array(value)
        .map((item) => text(item))
        .filter(Boolean);
}

function text(value: unknown, max?: number) {
    if (typeof value !== "string") return "";
    const normalized = value.trim();
    return max === undefined ? normalized : normalized.slice(0, max);
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

const namedAssetSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "description"],
    properties: {
        name: { type: "string" },
        description: { type: "string" },
        profile: {
            type: "object",
            additionalProperties: false,
            properties: {
                visualIdentity: { type: "string" },
                styling: { type: "string" },
                colorPalette: { type: "string" },
                consistencyRules: { type: "string" },
            },
        },
    },
};

export const dramaContentTool = {
    name: "analyze_drama_content",
    description: "只提取可审核的剧本内容结构，不生成任何图片或视频提示词",
    parameters: {
        type: "object",
        additionalProperties: false,
        required: ["episode", "characters", "scenes", "props", "clues", "shots"],
        properties: {
            episode: {
                type: "object",
                additionalProperties: false,
                required: ["outline", "hook", "nextPreview", "sourceRange"],
                properties: { outline: { type: "string" }, hook: { type: "string" }, nextPreview: { type: "string" }, sourceRange: { type: "string" } },
            },
            characters: { type: "array", items: namedAssetSchema },
            scenes: { type: "array", items: namedAssetSchema },
            props: { type: "array", items: namedAssetSchema },
            clues: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "description", "payoff"],
                    properties: { ...namedAssetSchema.properties, payoff: { type: "string" } },
                },
            },
            shots: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "description", "sourceText", "shotBoundary", "dialogue", "narration", "utterances", "duration", "characterNames", "sceneName", "propNames", "clueNames"],
                    properties: {
                        title: { type: "string" },
                        description: { type: "string", description: "只写画面中发生的动作、人物状态和可观察事实，不写角色台词摘要" },
                        sourceText: { type: "string", description: "对应原文的连续片段，尽量保留原文标点和引号" },
                        shotBoundary: { type: "string", description: "说明为何在此切镜；说话人转换、明显动作反应或场景变化应形成新镜头" },
                        dialogue: { type: "string", description: "只填写角色实际说出口的原话，不要写‘某人说明/表示/询问’等转述；没有明确台词就留空" },
                        narration: { type: "string", description: "只填写原文明确存在的画外音或旁白，不要把镜头事实改写成旁白" },
                        utterances: {
                            type: "array",
                            items: {
                                type: "object",
                                additionalProperties: false,
                                required: ["type", "speaker", "text"],
                                properties: {
                                    type: { type: "string", enum: ["dialogue", "voiceover"] },
                                    speaker: { type: "string", description: "dialogue 必须填写原文语境中的明确说话人姓名或身份，不得留空、填写‘说话人/未知’或只用无法定位的代词" },
                                    text: { type: "string", description: "逐句保留原话，不得改写、概括或合并遗漏" },
                                },
                            },
                        },
                        duration: { type: "integer", minimum: 1 },
                        characterNames: { type: "array", items: { type: "string" } },
                        sceneName: { type: "string" },
                        propNames: { type: "array", items: { type: "string" } },
                        clueNames: { type: "array", items: { type: "string" } },
                    },
                },
            },
        },
    },
};

export const dramaVisualTool = {
    name: "design_drama_visuals",
    description: "根据已经审核的镜头事实生成视觉结构，不改变镜头数量、顺序或内容",
    parameters: {
        type: "object",
        additionalProperties: false,
        required: ["shots"],
        properties: {
            shots: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["shotId", "imagePrompt", "videoPrompt", "cameraMotion", "startFramePrompt", "endFramePrompt", "negativePrompt", "continuity"],
                    properties: {
                        shotId: { type: "string" },
                        imagePrompt: { type: "string" },
                        videoPrompt: { type: "string" },
                        cameraMotion: { type: "string" },
                        startFramePrompt: { type: "string" },
                        endFramePrompt: { type: "string" },
                        negativePrompt: { type: "string" },
                        continuity: {
                            type: "object",
                            additionalProperties: false,
                            required: ["shotSize", "cameraAngle", "composition", "characterBlocking", "gazeDirection", "actionStart", "actionEnd", "screenDirection", "axisRule", "continuityNotes"],
                            properties: {
                                shotSize: { type: "string" },
                                cameraAngle: { type: "string" },
                                composition: { type: "string" },
                                characterBlocking: { type: "string" },
                                gazeDirection: { type: "string" },
                                actionStart: { type: "string" },
                                actionEnd: { type: "string" },
                                screenDirection: { type: "string" },
                                axisRule: { type: "string" },
                                continuityNotes: { type: "string" },
                            },
                        },
                    },
                },
            },
        },
    },
};
