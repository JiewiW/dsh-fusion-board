import type { ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'plugin:dsh-fusion-board': {
            kind: 'plugin:dsh-fusion-board';
        } & ContextFormed;
    }
}
