export interface ScanArgs {
    host: string;
    port: number;
    password: string;
    maxAddr: number;
    verbose: boolean;
    invalidMaxAddr: boolean;
}

/** Parse scan options separately from the optional port and password. */
export function parseScanArgs(argv: readonly string[]): ScanArgs {
    const positional: string[] = [];
    let maxAddrValue: string | undefined;
    let maxAddrProvided = false;
    let verbose = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--max-addr') {
            const next = argv[i + 1];
            const value = next !== undefined && !next.startsWith('--') ? argv[++i] : undefined;
            if (!maxAddrProvided) maxAddrValue = value;
            maxAddrProvided = true;
        } else if (arg === '--verbose') {
            verbose = true;
        } else if (!arg.startsWith('--')) {
            positional.push(arg);
        }
    }

    const maxAddrRaw = Number(maxAddrValue);
    const maxAddrValid = /^\d+$/.test(maxAddrValue ?? '') && Number.isInteger(maxAddrRaw) && maxAddrRaw >= 1 && maxAddrRaw <= 999;
    return {
        host: positional[0] ?? '',
        port: parseInt(positional[1] ?? '20000', 10),
        password: positional[2] ?? '',
        maxAddr: maxAddrValid ? maxAddrRaw : 20,
        verbose,
        invalidMaxAddr: maxAddrProvided && !maxAddrValid,
    };
}
