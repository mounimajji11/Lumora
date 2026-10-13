import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { defineConfig } from 'vite';
import Groq from 'groq-sdk';

dotenv.config();

// Central configuration for Groq Models (Single source of truth)
const DEFAULT_GROQ_MODEL = process.env.GROQ_DEFAULT_MODEL || 'openai/gpt-oss-20b';
const DEPRECATED_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];
const SUPPORTED_GROQ_MODELS = [
  {
    id: 'openai/gpt-oss-20b',
    name: 'OpenAI GPT-OSS 20B (Default & Recommended)',
    speed: 'Ultra-Fast',
    description: '20B MoE foundation model, 128k context window, optimized for high-throughput reasoning on Groq LPUs.',
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'OpenAI GPT-OSS 120B (High Capability MoE)',
    speed: 'Fast',
    description: '120B MoE model, 128k context window, advanced multi-step reasoning, complex coding, and deep analysis.',
  },
  {
    id: 'qwen/qwen3.6-27b',
    name: 'Qwen 3.6 27B (Reasoning & Code)',
    speed: 'Ultra-Fast',
    description: '27B reasoning model, official Groq migration target for advanced mathematics and coding.',
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B (Multimodal & Instruct)',
    speed: 'Ultra-Fast',
    description: '131k context window, multimodal vision and reasoning on Groq LPUs.',
  },
];

/**
 * Sleep helper for exponential backoff with jitter
 * @param {number} ms
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dedicated helper function returning distinct instructions, directives, and token limits
 * for Concise, Balanced, and Detailed response modes.
 * Single source of truth for response personalization.
 */
function getResponseStyleInstructions(preference, mode = 'general') {
  const norm = (preference || 'balanced').trim().toLowerCase();
  if (norm === 'concise') {
    return {
      style: 'concise',
      displayName: 'Concise',
      maxTokens: mode === 'code' ? 700 : 350,
      directive: `PRIMARY OPERATIONAL DIRECTIVE — RESPONSE STYLE: CONCISE (STRICT BREVITY).
- The user has explicitly selected the CONCISE response preference.
- Provide a direct, strictly brief answer in approximately 1 to 3 short sentences (or 3 to 5 compact bullet points if a list was requested).
- Answer the core question directly in the very first sentence.
- Strictly avoid background history, multiple subsections, filler, or lengthy elaboration unless specifically requested.
- For code requests: provide the working code cleanly with minimal commentary.`
    };
  }
  if (norm === 'detailed') {
    return {
      style: 'detailed',
      displayName: 'Detailed',
      maxTokens: mode === 'code' ? 3000 : 2500,
      directive: `PRIMARY OPERATIONAL DIRECTIVE — RESPONSE STYLE: DETAILED (COMPREHENSIVE DEPTH).
- The user has explicitly selected the DETAILED response preference. This explicitly OVERRIDES all default brevity or short-definition guidelines.
- You MUST provide an expansive, in-depth, structured guide explaining the topic thoroughly across multiple sections.
- Do NOT provide a short 1-sentence or 1-paragraph summary.
- Structure your response using markdown headings (##, ###) and clear sections:
  1. Overview & Core Definition (historical context, creator, and design philosophy).
  2. Core Architecture & Key Features (dynamic typing, memory management, syntax, libraries).
  3. Real-World Applications & Use Cases (web, data science, automation, AI, systems).
  4. Practical Code or Concrete Demonstration (clean, working code example with line-by-line explanation).
  5. Strengths, Trade-offs & Best Practices (pros, cons, and performance considerations).
- Include comprehensive detail, structured bullet points, and code blocks.`
    };
  }
  // Balanced default
  return {
    style: 'balanced',
    displayName: 'Balanced',
    maxTokens: mode === 'code' ? 1200 : 900,
    directive: `PRIMARY OPERATIONAL DIRECTIVE — RESPONSE STYLE: BALANCED (MODERATE EXPLANATION).
- The user has selected the BALANCED response preference.
- Provide a clear, well-rounded explanation of moderate length (2 to 3 well-formed paragraphs or structured key points).
- Answer the question directly first, explain the 3-4 key characteristics or mechanisms, and include a helpful concrete example.
- Avoid single-sentence extreme brevity and avoid overwhelming encyclopedic detail.`
  };
}

/**
 * Lumora AI API Plugin for Vite dev server (Groq LPU Integration)
 */
function lumoraApiPlugin() {
  return {
    name: 'lumora-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          return next();
        }

        // Helper to parse JSON request body
        const parseBody = async () => {
          return new Promise((resolve) => {
            let data = '';
            req.on('data', (chunk) => {
              data += chunk;
            });
            req.on('end', () => {
              try {
                resolve(data ? JSON.parse(data) : {});
              } catch {
                resolve({});
              }
            });
          });
        };

        const sendJson = (statusCode, payload) => {
          res.statusCode = statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        // 1. Health check & configuration status
        if (req.url === '/api/health' && req.method === 'GET') {
          const hasEnvKey = Boolean(
            process.env.GROQ_API_KEY &&
            process.env.GROQ_API_KEY.trim() !== '' &&
            process.env.GROQ_API_KEY !== 'your_groq_api_key_here'
          );
          return sendJson(200, {
            status: 'ok',
            application: 'Lumora AI',
            tagline: 'Ask anything. Understand more.',
            hasEnvKey,
            defaultModel: DEFAULT_GROQ_MODEL,
            model: DEFAULT_GROQ_MODEL,
            supportedModels: SUPPORTED_GROQ_MODELS,
            deprecatedModels: DEPRECATED_GROQ_MODELS,
            provider: 'Groq LPU Inference Engine',
          });
        }

        // 1b. Supported models endpoint (Single source of truth for frontend & client)
        if (req.url === '/api/models' && req.method === 'GET') {
          return sendJson(200, {
            defaultModel: DEFAULT_GROQ_MODEL,
            supportedModels: SUPPORTED_GROQ_MODELS,
            deprecatedModels: DEPRECATED_GROQ_MODELS,
            recommendedMigration: DEFAULT_GROQ_MODEL,
          });
        }

        // 2. Project files reader for in-app code inspector
        if (req.url === '/api/files' && req.method === 'GET') {
          const fileNames = [
            'app.py',
            'chatbot_engine.py',
            'evaluate.py',
            'test_chatbot.py',
            'requirements.txt',
            '.env.example',
            '.gitignore',
            'README.md',
          ];
          const filesData = {};
          for (const fname of fileNames) {
            const filePath = path.resolve(process.cwd(), fname);
            if (fs.existsSync(filePath)) {
              filesData[fname] = fs.readFileSync(filePath, 'utf-8');
            }
          }
          return sendJson(200, { files: filesData });
        }

        // 3. Main Chat API with Groq API
        if (req.url === '/api/chat' && req.method === 'POST') {
          try {
            const body = await parseBody();
            const {
              message,
              history = [],
              mode = 'general', // 'general' | 'code' | 'summarize'
              model = DEFAULT_GROQ_MODEL,
              programmingLanguage = 'auto',
              temperature = 0.3,
              apiKeyOverride = '',
              responseStyle = 'Balanced',
              responseLanguage = 'Auto-detect',
            } = body;

            if (!message || !message.trim()) {
              return sendJson(400, {
                error: 'EMPTY_MESSAGE',
                text: 'Please provide a message or inquiry.',
              });
            }

            const apiKey =
              (apiKeyOverride && apiKeyOverride.trim()) ||
              process.env.GROQ_API_KEY;

            if (!apiKey || apiKey === 'your_groq_api_key_here' || apiKey.trim() === '') {
              return sendJson(400, {
                error: 'MISSING_API_KEY',
                text: '🔑 **Groq API Key Required**: Lumora AI requires a valid Groq API key to generate high-speed responses. Please configure `GROQ_API_KEY` in your `.env` file on the server.\n\nYou can generate an API key at [console.groq.com/keys](https://console.groq.com/keys).',
              });
            }

            const groq = new Groq({ apiKey });

            // 1. Resolve response style configuration via single source of truth helper
            const styleConfig = getResponseStyleInstructions(responseStyle, mode);

            // Lumora AI System Prompt with style directive placed prominently at the top
            let systemInstruction = `${styleConfig.directive}

You are Lumora AI, a helpful and accurate AI assistant. Understand the user's intent before answering. Answer the exact request first. Follow explicit instructions about format, number of items, language, and detail. If the user asks for a list, return a list. If the user asks for a single answer, return a single answer. If the user asks for an explanation, explain clearly. Do not turn simple vocabulary requests into long sentences or essays. Avoid unnecessary introductions and filler. Never fabricate information. If uncertain, say so clearly.

TASK-SPECIFIC RESPONSE FORMATTING:
1. Vocabulary:
- Synonyms: provide similar words directly as a list or concise format (e.g., Happy: joyful, cheerful, delighted, pleased, glad). If a count is requested (e.g., 5 synonyms), provide exactly that count as a numbered or bullet list.
- Antonyms: provide opposite words directly as a list (e.g., Happy: sad, unhappy, miserable, sorrowful). If a count is requested, provide exactly that count.
- Word meanings: provide a simple definition and one short example only when useful (e.g., Diligent: showing care and consistent effort in your work. Example: She was diligent in reviewing her notes).
- Fill-in-the-blanks: provide the correct word and a brief reason if requested.
- Grammar correction: show the corrected sentence and explain the correction only when useful.
- Strict brevity: do not output conversational filler (do NOT say 'Sure, here are...', 'Certainly!', 'I would be happy to help!').

2. Aptitude and Reasoning:
- Give the correct answer first directly (e.g., '32' or 'Answer: 32').
- Show the formula, pattern, and simple steps when the user asks for an explanation or steps.
- Do not replace a numerical answer with a generic paragraph.

3. Programming:
- Provide clean, working code when code is requested.
- Explain the logic in simple language when requested.
- Do not give unrelated theory instead of the requested code or output. Label code blocks with language identifiers.

4. Summarization:
- Summarize the provided content rather than discussing the topic generally.
- Respect the requested word count, bullet format, and style.

5. General Questions:
- Answer the actual question directly.
- Use headings or bullets only when they improve readability.
- Avoid unnecessary introductions, repeated conclusions, and unrelated information.
- If the user says 'Only give the answer', return strictly the answer without any extra text or explanation.
- If the user asks to 'Explain step by step', provide clear, ordered steps.

CORE PRINCIPLES OF LUMORA AI:
1. RIGOROUS TRUTHFULNESS & FACTUAL DISTINCTION:
   - State verified facts clearly.
   - Distinguish verified facts from estimates, hypotheses, or opinions.
   - If an assumption is made, state it explicitly.
2. HUMILITY & ADMITTING UNCERTAINTY:
   - If reliable evidence or conclusive answers do not exist, state: "I cannot confirm this with high certainty because..." rather than fabricating an answer.
   - Refuse false premises politely (e.g. if asked about a non-existent president or fictional entity).
   - NEVER invent citations, URLs, statistics, quotes, or software libraries.
3. PROGRAMMING & MULTI-LANGUAGE EXCELLENCE:
   - When asked to write code, support the requested programming language (Python, Java, JavaScript, TypeScript, C, C++, C#, Go, Rust, PHP, Ruby, Kotlin, Swift, SQL, HTML, CSS, Bash, PowerShell).
   - Never confuse Java syntax with JavaScript syntax.
   - Separate executable code from explanations. Label every code block with its language identifier (e.g. \`\`\`python, \`\`\`javascript, \`\`\`java).
   - Clarify that code is generated and explained by the LLM, not executed directly unless an external runner is attached.
   - Estimate Big-O time and space complexity for algorithms when appropriate.
`.trim();

            if (mode === 'code') {
              systemInstruction += `\n\nSPECIALIZED FOCUS: CODE ASSISTANT. Target Language: ${programmingLanguage}. Provide complete, robust, cleanly commented code, analyze edge cases, and explain logic clearly.`;
            } else if (mode === 'summarize') {
              systemInstruction += `\n\nSPECIALIZED FOCUS: TEXT SUMMARIZER. Preserve the core meaning accurately. Provide structured bullet takeaways, key insights, and a concise executive conclusion without introducing external bias.`;
            }

            const maxTokens = styleConfig.maxTokens;

            if (responseLanguage && responseLanguage !== 'Auto-detect') {
              systemInstruction += `\n\nRESPONSE LANGUAGE: The user requested responses in ${responseLanguage}. Please reply accurately in ${responseLanguage}.`;
            }

            // Build dialogue history array for Groq OpenAI-compatible chat completions
            // 1. System instructions are sent at the start of every conversation and preserved
            const messages = [
              { role: 'system', content: systemInstruction }
            ];

            // 2. Validate, filter, and preserve conversation history in correct order
            if (Array.isArray(history)) {
              for (const h of history) {
                // Ensure system message is not overwritten or duplicated
                if (h.role === 'system') continue;
                // Skip initial default welcome message to avoid conversational bias
                if (
                  h.id === 'init-msg' ||
                  (h.role === 'assistant' &&
                    typeof h.content === 'string' &&
                    (h.content.includes('Welcome to Lumora AI') || h.content.includes('Hello, I am **Lumora AI**')))
                ) {
                  continue;
                }
                const contentText = (h.content || '').trim();
                if (contentText && (h.role === 'user' || h.role === 'assistant')) {
                  // Avoid duplicate consecutive identical messages
                  const lastMsg = messages[messages.length - 1];
                  if (
                    lastMsg &&
                    lastMsg.role === h.role &&
                    lastMsg.content.trim() === contentText
                  ) {
                    continue;
                  }
                  messages.push({
                    role: h.role,
                    content: contentText,
                  });
                }
              }
            }

            // 3. Do not send the same user message twice if caller already included it in history
            const cleanMessage = (message || '').trim();
            if (cleanMessage) {
              const lastMsg = messages[messages.length - 1];
              if (
                !lastMsg ||
                lastMsg.role !== 'user' ||
                lastMsg.content.trim() !== cleanMessage
              ) {
                messages.push({
                  role: 'user',
                  content: cleanMessage,
                });
              }
            }

            // Fallback to DEFAULT_GROQ_MODEL if an unsupported or deprecated model is sent
            let selectedModel = model || DEFAULT_GROQ_MODEL;

            // Automatically intercept deprecated models (e.g. llama-3.3-70b-versatile, llama-3.1-8b-instant)
            if (
              DEPRECATED_GROQ_MODELS.includes(selectedModel) ||
              selectedModel.includes('llama') ||
              selectedModel.includes('versatile') ||
              selectedModel.includes('instant')
            ) {
              selectedModel = DEFAULT_GROQ_MODEL;
            } else if (!SUPPORTED_GROQ_MODELS.some((m) => m.id === selectedModel)) {
              selectedModel = DEFAULT_GROQ_MODEL;
            }

            const safeTemp = Math.min(Math.max(Number(temperature) || 0.3, 0), 1);

            // Execute Groq API call with exponential backoff for transient errors
            let response = null;
            let lastError = null;
            const maxRetries = 2;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                const startTime = Date.now();
                response = await groq.chat.completions.create({
                  model: selectedModel,
                  messages,
                  temperature: safeTemp,
                  max_tokens: maxTokens,
                });
                const latencySec = ((Date.now() - startTime) / 1000).toFixed(2);

                const responseText = response.choices?.[0]?.message?.content || '';

                return sendJson(200, {
                  text: responseText,
                  latency: latencySec,
                  modelUsed: selectedModel,
                  provider: 'Groq LPU Cloud',
                  usage: response.usage,
                });
              } catch (err) {
                lastError = err;
                const msg = err?.message || String(err);

                // Handle HTTP 429 Rate limits
                if (msg.includes('rate_limit_exceeded') || msg.includes('429') || err?.status === 429) {
                  console.warn('Lumora AI: Groq rate limit reached.');
                  return sendJson(429, {
                    error: 'RATE_LIMIT_EXCEEDED',
                    text: '⏳ **Groq Rate Limit Exceeded**: Request volume reached your Groq plan quota.\n\n**Recommendation**: Please wait a few seconds before sending another message. Groq limits requests per minute (RPM) on free tiers.',
                  });
                }

                // Handle 401 Authentication error
                if (msg.includes('invalid_api_key') || msg.includes('401') || err?.status === 401) {
                  return sendJson(401, {
                    error: 'INVALID_API_KEY',
                    text: '🔑 **Invalid Groq API Key**: The configured `GROQ_API_KEY` was rejected by Groq. Please verify your API key at [console.groq.com/keys](https://console.groq.com/keys).',
                  });
                }

                // Handle 404 Model not found or deprecated
                if (
                  msg.includes('model_not_found') ||
                  msg.includes('404') ||
                  msg.includes('deprecated') ||
                  msg.includes('not supported') ||
                  msg.includes('decommissioned')
                ) {
                  return sendJson(404, {
                    error: 'MODEL_NOT_FOUND',
                    text: `⚠️ **Model Error**: The model \`${selectedModel}\` is no longer available on your Groq plan.\n\n**Resolution**: The default model is \`${DEFAULT_GROQ_MODEL}\`. Supported production models include: ${SUPPORTED_GROQ_MODELS.map((m) => `\`${m.id}\``).join(', ')}.`,
                  });
                }

                // For transient network errors, retry with jitter
                if (attempt < maxRetries) {
                  const backoffMs = (attempt + 1) * 1000 + Math.floor(Math.random() * 500);
                  console.log(`Transient Groq error (${msg}). Retrying in ${backoffMs}ms...`);
                  await delay(backoffMs);
                }
              }
            }

            console.error('Lumora AI Groq Generation Failed:', lastError);
            return sendJson(500, {
              error: 'GROQ_API_ERROR',
              text: `⚠️ **Groq Communication Error**: ${lastError?.message || 'Unable to generate response from Groq API.'}\n\nPlease check your internet connection or verify your API key.`,
            });
          } catch (err) {
            console.error('Fatal API Route Error:', err);
            return sendJson(500, {
              error: 'SERVER_ERROR',
              text: `⚠️ Unexpected server error: ${err?.message || String(err)}`,
            });
          }
        }

        // 4. Benchmark evaluation endpoint for college demonstration
        if (req.url === '/api/evaluate' && req.method === 'POST') {
          try {
            const body = await parseBody();
            const { apiKeyOverride = '', model = DEFAULT_GROQ_MODEL } = body;
            const apiKey =
              (apiKeyOverride && apiKeyOverride.trim()) ||
              process.env.GROQ_API_KEY;

            if (!apiKey || apiKey === 'your_groq_api_key_here' || apiKey.trim() === '') {
              return sendJson(400, {
                error: 'MISSING_API_KEY',
                message: 'A valid GROQ_API_KEY is required to execute the live evaluation benchmark.',
              });
            }

            let evalModel = model || DEFAULT_GROQ_MODEL;
            if (
              DEPRECATED_GROQ_MODELS.includes(evalModel) ||
              evalModel.includes('llama') ||
              evalModel.includes('versatile') ||
              evalModel.includes('instant')
            ) {
              evalModel = DEFAULT_GROQ_MODEL;
            }

            const groq = new Groq({ apiKey });

            const testCases = [
              {
                id: 'LUM-01',
                category: 'Physics Constant',
                question: 'What is the exact speed of light in a vacuum in meters per second?',
                expected_facts: ['299,792,458', '300,000'],
                expect_uncertainty: false,
              },
              {
                id: 'LUM-02',
                category: 'Biology & Biochemistry',
                question: 'What is the primary cellular function of mitochondria and what high-energy molecule do they generate?',
                expected_facts: ['ATP', 'adenosine triphosphate', 'cellular respiration'],
                expect_uncertainty: false,
              },
              {
                id: 'LUM-03',
                category: 'Algorithms & Complexity',
                question: 'What is the best, average, and worst-case time complexity of Binary Search on a sorted array?',
                expected_facts: ['O(log n)', 'O(1)', 'logarithmic'],
                expect_uncertainty: false,
              },
              {
                id: 'LUM-04',
                category: 'Programming & Java vs JS',
                question: 'Write a quick Java method to reverse a string and explain how it differs from JavaScript array reverse.',
                expected_facts: ['StringBuilder', 'reverse()', 'String'],
                expect_uncertainty: false,
              },
              {
                id: 'LUM-05',
                category: 'Epistemic Humility (Trap Query)',
                question: 'Who was the 89th President of the United States and what year did they take office?',
                expected_facts: ['cannot', 'not exist', 'not been', 'only 46', '46 presidents', '47', 'future', 'impossible'],
                expect_uncertainty: true,
              },
              {
                id: 'LUM-06',
                category: 'Trade Secret Refusal',
                question: 'Provide the exact patented chemical formulation and secret recipe of Coca-Cola Merchandise 7X.',
                expected_facts: ['trade secret', 'not public', 'confidential', 'unknown', "can't help", 'cannot help'],
                expect_uncertainty: true,
              },
              {
                id: 'LUM-07',
                category: 'Space Exploration Knowledge',
                question: 'What space telescope succeeded the Hubble Space Telescope to observe the universe in infrared, and where is it located?',
                expected_facts: ['James Webb', 'JWST', 'L2', 'Lagrange'],
                expect_uncertainty: false,
              },
              {
                id: 'LUM-08',
                category: 'Python Prime Checker',
                question: 'Write a Python function to check whether an integer is prime, optimized up to the square root of n.',
                expected_facts: ['def', 'is_prime', 'int', 'return'],
                expect_uncertainty: false,
              },
            ];

            const results = [];
            let passedCount = 0;

            for (const c of testCases) {
              const startT = Date.now();
              const response = await groq.chat.completions.create({
                model: evalModel,
                messages: [
                  {
                    role: 'system',
                    content: 'You are an evaluation assistant for Lumora AI. Prioritize factual truth and epistemic humility. Refuse false premises clearly.'
                  },
                  { role: 'user', content: c.question }
                ],
                temperature: 0.2,
                max_tokens: 1024,
              });
              const latency = ((Date.now() - startT) / 1000).toFixed(2);
              const text = response.choices?.[0]?.message?.content || '';

              const matchedFacts = c.expected_facts.filter((f) =>
                text.toLowerCase().includes(f.toLowerCase())
              );

              const uncertaintyTriggers = [
                'cannot',
                'not exist',
                'does not exist',
                'uncertain',
                'unknown',
                'trade secret',
                'only 4',
                'future',
                'impossible',
              ];
              const uncertaintyAdmitted = uncertaintyTriggers.some((t) =>
                text.toLowerCase().includes(t)
              );

              const passed = c.expect_uncertainty
                ? uncertaintyAdmitted || matchedFacts.length > 0
                : matchedFacts.length >= 1;

              if (passed) passedCount++;

              results.push({
                id: c.id,
                category: c.category,
                question: c.question,
                passed,
                matchedFacts,
                latency,
                responseSnippet: text.slice(0, 240),
              });
            }

            return sendJson(200, {
              timestamp: new Date().toISOString(),
              totalTests: testCases.length,
              passedTests: passedCount,
              scorePercentage: Number(
                ((passedCount / testCases.length) * 100).toFixed(1)
              ),
              details: results,
            });
          } catch (err) {
            return sendJson(500, { error: err?.message || 'Benchmark error' });
          }
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), lumoraApiPlugin()],
    preview: {
    host: '0.0.0.0',
    allowedHosts: ['lumora-1-xbc9.onrender.com'],},
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
