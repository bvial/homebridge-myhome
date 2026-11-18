import { createHash, randomBytes } from 'node:crypto';

/** Legrand HMAC v1.1 (2016): https://developer.legrand.com/uploads/2019/12/Hmac.pdf */
export type OwnHashAlgorithm = 'sha1' | 'sha256';

export function encodeOwnHash(hex: string): string {
    if (!/^[\da-f]+$/i.test(hex)) throw new Error('Invalid hexadecimal digest');
    return [...hex].map(digit => parseInt(digit, 16).toString().padStart(2, '0')).join('');
}

export function decodeOwnHash(value: string, bytes: number): string {
    if (value.length !== bytes * 4 || !/^(?:0\d|1[0-5])+$/.test(value)) throw new Error('Malformed OpenWebNet authentication digest');
    return value.match(/\d{2}/g)!.map(pair => Number(pair).toString(16)).join('');
}

export function createOwnHmacResponse(password: string, nonce: string, algorithm: OwnHashAlgorithm,
    random: Buffer = randomBytes(algorithm === 'sha1' ? 20 : 32)): { packet: string; serverProof: string } {
    if (!/^[a-z\d]{1,30}$/i.test(password)) throw new Error('HMAC password must contain 1..30 alphanumeric characters');
    const bytes = algorithm === 'sha1' ? 20 : 32;
    if (random.length !== bytes) throw new Error('Invalid client nonce length');
    const hash = (text: string) => createHash(algorithm).update(text, 'utf8').digest('hex');
    const ra = decodeOwnHash(nonce, bytes);
    const rb = random.toString('hex');
    const key = hash(password);
    // The protocol calls this HMAC, but mandates a digest of concatenated ASCII
    // hex strings, with these case-sensitive identities (not crypto.createHmac).
    const proof = encodeOwnHash(hash(ra + rb + '736F70653E' + '636F70653E' + key));
    return {
        packet: `*#${encodeOwnHash(rb)}*${proof}##`,
        serverProof: encodeOwnHash(hash(ra + rb + key)),
    };
}
