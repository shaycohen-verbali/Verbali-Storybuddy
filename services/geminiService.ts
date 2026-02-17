import { GoogleGenAI, Type, Modality, GenerateContentResponse } from "@google/genai";
import { FileData, ChatTurn, StoryMetadata } from '../types';

// Singleton AudioContext to prevent "Max AudioContexts reached" error
let audioContext: AudioContext | null = null;

const getAudioContext = () => {
  if (!audioContext) {
    // Use default sample rate of the device for the context
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
};

// Helper to convert base64 to Uint8Array
const base64ToBytes = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

// Helper to decode raw PCM data into an AudioBuffer manually
const pcmToAudioBuffer = (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): AudioBuffer => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Shuffle helper for answers
const shuffleArray = <T>(array: T[]): T[] => {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
};

const isWhereQuestion = (question: string): boolean => /^\s*where\b/i.test(question || '');

const inferLocationFromSummary = (summary: string): string => {
  const s = (summary || '').toLowerCase();
  if (/(ocean|sea|underwater|reef|shark|whale|fish)/.test(s)) return "In the ocean";
  if (/(beach|shore|coast)/.test(s)) return "On the beach";
  if (/(forest|jungle|woods|tree)/.test(s)) return "In the forest";
  if (/(home|house|bedroom|kitchen)/.test(s)) return "At home";
  if (/(school|classroom)/.test(s)) return "At school";
  if (/(farm|barn)/.test(s)) return "On a farm";
  if (/(city|town|street)/.test(s)) return "In the city";
  if (/(cave)/.test(s)) return "In a cave";
  return "In the ocean";
};

const simplifyOptionText = (text: string, question: string): string => {
  let value = String(text || "").trim().replace(/[.?!]+$/g, "").replace(/\s+/g, " ");
  if (!value) return value;

  if (isWhereQuestion(question)) {
    value = value.replace(/^(a|an|the)\s+/i, "");
    if (!/^(in|on|at)\s+/i.test(value)) {
      value = `In ${value.toLowerCase()}`;
    }
  }

  const words = value.split(" ");
  if (words.length > 10) {
    value = words.slice(0, 10).join(" ");
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
};

const buildFallbackOptions = (question: string, summary?: string): string[] => {
  if (isWhereQuestion(question)) {
    return [
      inferLocationFromSummary(summary || ""),
      "In space",
      "In the desert"
    ];
  }

  return ["Not in this book", "Maybe", "No idea"];
};

const normalizeOptionSet = (text: string, question: string, summary?: string): string[] => {
  try {
    const parsed = JSON.parse(text || '{}');
    const options = Array.isArray(parsed?.options) ? parsed.options : [];
    const mapped = options
      .map((opt: any) => ({
        text: simplifyOptionText(String(opt?.text || ''), question),
        isCorrect: Boolean(opt?.is_correct),
      }))
      .filter((opt: any) => opt.text.length > 0)
      .slice(0, 3);

    if (mapped.length !== 3) {
      return buildFallbackOptions(question, summary);
    }

    const correctCount = mapped.filter((opt: any) => opt.isCorrect).length;
    if (correctCount !== 1) {
      mapped[0].isCorrect = true;
      mapped[1].isCorrect = false;
      mapped[2].isCorrect = false;
    }

    return shuffleArray(mapped.map((opt: any) => opt.text));
  } catch (e) {
    return buildFallbackOptions(question, summary);
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getAIClient = () => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("VITE_GEMINI_API_KEY is missing. Legacy client-side Gemini flow may fail.");
  }
  return new GoogleGenAI({ apiKey: apiKey });
};

// --- RETRY LOGIC ---
const retryWithBackoff = async <T>(fn: () => Promise<T>, retries = 5, delayMs = 2000): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    let msg = "";
    try {
        msg = (error.message || "") + JSON.stringify(error);
    } catch (e) {
        msg = error.toString();
    }

    if (retries > 0 && (
        msg.includes("429") || 
        msg.includes("RESOURCE_EXHAUSTED") || 
        msg.includes("quota") ||
        msg.includes("503") || 
        msg.includes("Overloaded")
    )) {
      console.warn(`API Rate Limited. Retrying in ${delayMs}ms... (${retries} attempts left)`);
      await delay(delayMs);
      return retryWithBackoff(fn, retries - 1, delayMs * 2); 
    }
    throw error;
  }
};

/**
 * Step 1: Analyze Story Structure (Simplified)
 * Returns summary and art style.
 */
export const analyzeStoryStructure = async (storyFile: FileData): Promise<{ 
  summary: string, 
  artStyle: string
}> => {
  const ai = getAIClient();
  
  const promptText = `
    Analyze this PDF. Return valid JSON.
    1. Summary (2 sentences max, clear and simple for children).
    2. Art style (describe the visual style of the book in 5 words, e.g., "watercolor, soft pastel, cartoon").
    `;

  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { mimeType: storyFile.mimeType, data: storyFile.data } },
          { text: promptText }
        ]
      },
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            art_style: { type: Type.STRING },
          },
          required: ["summary", "art_style"]
        }
      }
    }));
    
    const text = response.text || "{}";
    const result = JSON.parse(text);
    
    return {
        summary: result.summary || "Story analyzed.",
        artStyle: result.art_style || "Children's book illustration"
    };

  } catch (e: any) {
    console.error("Analysis failed", e);
    const msg = e.message || e.toString();
    if (msg.includes("403") || msg.includes("Permission denied")) {
        throw new Error("Permission Denied: Check API Key.");
    }
    throw new Error("Could not read the story. Ensure it is a valid PDF.");
  }
};

/**
 * Step 2: Generate Cover Image
 * Accepts optional referenceFile (the story PDF) to match style.
 */
export const generateCoverIllustration = async (
  summary: string,
  artStyle: string,
  referenceFile?: FileData
): Promise<string | null> => {
  const ai = getAIClient();
  
  const promptText = `Generate a cover image for a children's book.
  Story Summary: ${summary}.
  
  STYLE INSTRUCTION:
  - Art Style Description: ${artStyle}.
  - MIMIC THE STYLE OF THE ATTACHED FILE EXACTLY if provided.
  - Keep it colorful, simple, and engaging for a non-verbal child.
  `;

  const parts: any[] = [];
  if (referenceFile) {
      parts.push({
          inlineData: {
              mimeType: referenceFile.mimeType,
              data: referenceFile.data
          }
      });
  }
  parts.push({ text: promptText });

  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
        model: 'nano-banana-pro',
        contents: { parts },
        config: {
            imageConfig: { aspectRatio: "3:4" }
        }
    }), 2);
    
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error) {
    console.error("Cover generation failed", error);
    return null;
  }
};

export const transcribeParentQuestion = async (
  audioBase64: string, 
  mimeType: string,
  context?: StoryMetadata
): Promise<string> => {
  try {
    const ai = getAIClient();
    
    let promptText = `Listen to this audio. This is a reading-comprehension activity for a non-verbal child.
    The parent asks the question; the child chooses one answer from options.
    Transcribe only the parent's full inquiry exactly as spoken.`;
    
    if (context) {
      promptText += `
      CONTEXT:
      Story Summary: ${context.summary}
      The question is likely related to this story context.
      `;
    }

    promptText += " Return ONLY the transcription text.";

    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: audioBase64
            }
          },
          { text: promptText }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 0 } 
      }
    }));
    return response.text?.trim() || "";
  } catch (error) {
    console.error("Error transcribing audio:", error);
    throw new Error("Could not understand the question.");
  }
};

export const generateAnswerOptions = async (
  question: string,
  storyContext: FileData | null,
  history: ChatTurn[],
  metadata?: StoryMetadata
): Promise<string[]> => {
  try {
    const ai = getAIClient();
    const parts: any[] = [];
    
    if (storyContext) {
        parts.push({
            inlineData: {
                mimeType: storyContext.mimeType,
                data: storyContext.data
            }
        });
    }
    
    let historyText = "Conversation History:\n";
    history.forEach((turn, i) => {
        historyText += `${turn.role === 'parent' ? 'Parent' : 'Child'}: ${turn.text}\n`;
    });

    let prompt = `
      You are helping a non-verbal child answer a reading-comprehension question.
      The parent is the reader. The child is the answerer.
      The parent just asked: "${question}"
      ${historyText}
      Use simple child language (age 3-7), no advanced vocabulary.
      Task: Return exactly 3 short answers (up to 10 words each).
      Exactly ONE answer must be correct based on the story.
      The other TWO must be clearly incorrect but plausible distractors.
      For "Where" questions, use location phrases like "In the ocean", "At home", or "At school".
      If question is not answerable from the story, use "Not in this book" as the only correct option.
      Return strict JSON object: {"options":[{"text":"...","is_correct":true|false}, ...]}.
    `;

    if (metadata) {
      prompt += `\nStory Summary: ${metadata.summary}`;
    }

    parts.push({ text: prompt });

    // Use Flash for answering - speed is key for conversation flow
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: 'gemini-3-flash-preview', 
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  is_correct: { type: Type.BOOLEAN }
                },
                required: ["text", "is_correct"]
              }
            }
          },
          required: ["options"]
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    }));

    let text = (response.text || "{}").replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return normalizeOptionSet(text, question, metadata?.summary);
    } catch (e) {
      return buildFallbackOptions(question, metadata?.summary);
    }
  } catch (error) {
    console.error("Error generating options:", error);
    return buildFallbackOptions(question, metadata?.summary);
  }
};

export const generateIllustration = async (
  answerText: string,
  storyContext: FileData | null,
  styleImages: FileData[],
  metadata?: StoryMetadata,
  otherOptions: string[] = [],
  conversationHistory: ChatTurn[] = []
): Promise<string | null> => {
  const ai = getAIClient();
  
  // Build prompt
  let promptText = `Generate a children's book illustration for: "${answerText}".
  
  STYLE INSTRUCTIONS (CRITICAL):
  - You MUST match the artistic style of the attached reference images EXACTLY.
  - Replicate the line work, coloring technique, character design, and texture.
  - Art Style Description: ${metadata?.artStyle || "Children's book illustration"}.
  - If multiple references are provided, create a cohesive image that fits that specific book's universe.
  
  CONTENT:
  - Subject: ${answerText}.
  - Background: Keep it clean/white or minimal to avoid distraction for a non-verbal child.
  - Clarity: The concept "${answerText}" must be immediately recognizable.
  `;

  const parts: any[] = [];
  
  // Add style references
  // Prioritize explicit style images, fallback to story PDF
  if (styleImages.length > 0) {
      styleImages.slice(0, 2).forEach((img) => {
          parts.push({
              inlineData: {
                  mimeType: img.mimeType,
                  data: img.data
              }
          });
      });
  } else if (storyContext) {
      // Use the whole PDF as style reference if no specific images are cut out
      parts.push({
          inlineData: {
              mimeType: storyContext.mimeType,
              data: storyContext.data
          }
      });
  }

  parts.push({ text: promptText });

  const extractImage = (response: GenerateContentResponse): string | null => {
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    return null;
  };

  // TRY FLASH FIRST for Speed in interaction loop
  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
        model: 'nano-banana-pro',
        contents: { parts },
        config: {
            imageConfig: { aspectRatio: "1:1" }
        }
    }), 2);
    return extractImage(response);
  } catch (error) {
    console.warn("Flash image failed", error);
    return null;
  }
};

export const speakText = async (text: string): Promise<void> => {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const ai = getAIClient();
  
  try {
    const response = await retryWithBackoff<GenerateContentResponse>(() => ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: { parts: [{ text }] },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
        },
      },
    }));

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) return;

    const audioBytes = base64ToBytes(base64Audio);
    const audioBuffer = pcmToAudioBuffer(audioBytes, ctx, 24000, 1);
    
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();

  } catch (error) {
    console.error("TTS Error:", error);
  }
};
