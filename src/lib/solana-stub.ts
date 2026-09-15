/**
 * Stands in for `@solana/web3.js` in the browser bundle.
 *
 * The Farcaster mini app SDK imports Solana's web3 library for a Solana wallet provider — a
 * feature this app never asks for (everything here is Base). Left alone it is ~650 KB of the
 * first bundle every visitor downloads. `next.config.ts` points the import here instead; the
 * SDK only touches these names inside its Solana provider methods, which nothing in BStocks
 * calls. If one ever were called, it fails loudly rather than silently.
 */
function unsupported(): never {
  throw new Error("Solana is not supported in BStocks; every action settles on Base.");
}

export class Connection {
  constructor() {
    unsupported();
  }
}

export class Transaction {
  static from(): never {
    return unsupported();
  }
  serialize(): never {
    return unsupported();
  }
}

export class VersionedMessage {
  static deserialize(): never {
    return unsupported();
  }
}

export class VersionedTransaction {
  static deserialize(): never {
    return unsupported();
  }
  serialize(): never {
    return unsupported();
  }
}

export class PublicKey {
  constructor() {
    unsupported();
  }
}
