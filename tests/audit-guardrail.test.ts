// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
const script = readFileSync('scripts/guardrail-audit.js', 'utf8');
it.each([
    { status: 1, stdout: '{"error":{"code":"ENOTFOUND"}}' },
    { status: 0, stdout: 'invalid json' },
    { status: null, error: new Error('spawn failed'), stdout: '' }
])('bloqueia auditoria indisponível: %j', (result) => {
    const exit = vi.fn(() => { throw new Error('blocked'); });
    expect(() => runInNewContext(script, {
        require: () => ({ spawnSync: () => result }), console: { log() {}, error() {} }, process: { exit }
    })).toThrow('blocked');
    expect(exit).toHaveBeenCalledWith(1);
});
it('aceita relatório completo sem vulnerabilidades', () => {
    const processMock = { exit: vi.fn(), exitCode: 0 };
    runInNewContext(script, {
        require: () => ({ spawnSync: () => ({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0, info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) }) }),
        console: { log() {}, error() {} }, process: processMock
    });
    expect(processMock.exit).not.toHaveBeenCalled();
    expect(processMock.exitCode).toBe(0);
});
