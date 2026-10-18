/**
 * The AI providers Plume can talk to. Two wire formats cover them all:
 * - "anthropic": Anthropic's Messages API (Anthropic itself, and gateways such as LiteLLM that speak it);
 * - "openai": the OpenAI Chat Completions format, which nearly every other provider offers.
 * Model names are starting points; the owner can type any name the provider offers.
 */
export type ProviderId =
  | 'anthropic'
  | 'gateway'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'openrouter'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'perplexity'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export interface Provider {
  id: ProviderId;
  label: string;
  format: 'anthropic' | 'openai';
  /** Where calls go when the owner doesn't type an address. Empty = the owner must type one. */
  baseUrl: string;
  /** The owner may type their own address (a gateway, or a local server on another machine). */
  urlEditable: boolean;
  needsKey: boolean;
  /** Read from .env when LLM_PROVIDER names this provider and LLM_API_KEY is not set. */
  envKey?: string;
  /** Where to get a key. */
  keyUrl?: string;
  models: { research: string; draft: string; score: string };
  /** Runs on this computer: calls cost nothing. */
  local?: boolean;
  note?: string;
}

const gptOss = (prefix: string, small = 'gpt-oss-20b') => ({ research: `${prefix}gpt-oss-120b`, draft: `${prefix}gpt-oss-120b`, score: `${prefix}${small}` });

export const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    urlEditable: false,
    needsKey: true,
    envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: { research: 'claude-opus-5-5', draft: 'claude-sonnet-5-5', score: 'claude-haiku-5-5' },
    note: 'Best results. Web search is built in.',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: { research: 'gpt-5', draft: 'gpt-5', score: 'gpt-5-mini' },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    urlEditable: false,
    needsKey: true,
    envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: { research: 'gemini-2.5-pro', draft: 'gemini-2.5-flash', score: 'gemini-2.5-flash-lite' },
  },
  {
    id: 'groq',
    label: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    models: gptOss('openai/'),
    note: 'Very fast and cheap.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    format: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: { research: 'mistral-large-latest', draft: 'mistral-medium-latest', score: 'mistral-small-latest' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: { research: 'deepseek-chat', draft: 'deepseek-chat', score: 'deepseek-chat' },
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    format: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai',
    models: { research: 'grok-4', draft: 'grok-4', score: 'grok-3-mini' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (hundreds of models)',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    models: { research: 'openai/gpt-5', draft: 'openai/gpt-5', score: 'openai/gpt-5-mini' },
    note: 'One key for models from every company. Names look like openai/gpt-5 or google/gemini-2.5-flash.',
  },
  {
    id: 'together',
    label: 'Together AI',
    format: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    models: gptOss('openai/'),
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    format: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'FIREWORKS_API_KEY',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    models: gptOss('accounts/fireworks/models/'),
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    format: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    urlEditable: false,
    needsKey: true,
    envKey: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai',
    models: gptOss('', 'gpt-oss-120b'),
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    format: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    urlEditable: false,
    needsKey: true,
    envKey: 'PERPLEXITY_API_KEY',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    models: { research: 'sonar-pro', draft: 'sonar-pro', score: 'sonar' },
    note: "Its models don't use Plume's tools, so the chat assistant can only answer, not act.",
  },
  {
    id: 'ollama',
    label: 'Ollama (on this computer)',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    urlEditable: true,
    needsKey: false,
    models: { research: 'llama3.3', draft: 'llama3.3', score: 'llama3.2' },
    local: true,
    note: 'Free and private. Download a model first, e.g. "ollama pull llama3.3". Small models write noticeably worse.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this computer)',
    format: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    urlEditable: true,
    needsKey: false,
    models: { research: 'openai/gpt-oss-20b', draft: 'openai/gpt-oss-20b', score: 'openai/gpt-oss-20b' },
    local: true,
    note: 'Free and private. Start the local server in LM Studio and use the model names it lists.',
  },
  {
    id: 'gateway',
    label: 'LiteLLM or another Anthropic-style gateway',
    format: 'anthropic',
    baseUrl: '',
    urlEditable: true,
    needsKey: true,
    models: { research: 'claude-opus-5-5', draft: 'claude-sonnet-5-5', score: 'claude-haiku-5-5' },
    note: "Your company's gateway. Also the way to reach Amazon Bedrock or Google Vertex.",
  },
  {
    id: 'custom',
    label: 'Any other OpenAI-compatible service',
    format: 'openai',
    baseUrl: '',
    urlEditable: true,
    needsKey: false,
    models: { research: 'gpt-5', draft: 'gpt-5', score: 'gpt-5-mini' },
    note: 'Azure OpenAI, vLLM, LocalAI and others. Enter the address that ends in /v1. For Azure, add the header "api-key: <your key>".',
  },
];

export function getProvider(id: string | undefined): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === 'string' && PROVIDERS.some((p) => p.id === id);
}

/** Older saved settings and .env have no provider: an address means a gateway, none means Anthropic. */
export function inferProvider(baseUrl: string): ProviderId {
  return baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(baseUrl) ? 'gateway' : 'anthropic';
}
