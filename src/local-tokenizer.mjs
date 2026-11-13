// Build-time entry only. encode/count ordinary text, including literal special-token strings.
import { countTokens, setMergeCacheSize } from 'gpt-tokenizer/encoding/o200k_base';
setMergeCacheSize(0);
const ordinary = { disallowedSpecial: new Set() };
export const count = text => countTokens(text, ordinary);
