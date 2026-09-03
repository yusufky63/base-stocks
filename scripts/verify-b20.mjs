import { createPublicClient, http, fallback, keccak256, stringToHex, parseAbi, zeroAddress, formatUnits } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: fallback([
    http('https://base-rpc.publicnode.com'),
    http('https://base.llamarpc.com'),
    http('https://1rpc.io/base'),
    http('https://mainnet.base.org'),
  ]),
});
const NVDA = '0xb20000000000000000000078ee7ce2fE4908108C';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NVDA_FEED = '0x04689a41629776563E6822F76f2e57D148d28513';
const POLICY_REGISTRY = '0x8453000000000000000000000000000000000002';
const FACTORY = '0xB20f000000000000000000000000000000000000';
const ORACLE_REGISTRY = '0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD';

const b20 = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function multiplier() view returns (uint256)',
  'function WAD_PRECISION() view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint64)',
  'function scaledBalanceOf(address) view returns (uint256)',
  'function toScaledBalance(uint256) view returns (uint256)',
  'function toRawBalance(uint256) view returns (uint256)',
  'function isPaused(uint8) view returns (bool)',
  'function pausedFeatures() view returns (uint8[])',
  'function policyId(bytes32) view returns (uint256)',
  'function contractURI() view returns (string)',
  'function supplyCap() view returns (uint128)',
  'function extraMetadata(bytes32) view returns (string)',
]);
const registry = parseAbi([
  'function isAuthorized(address account, uint256 policyId) view returns (bool)',
  'function policyExists(uint256) view returns (bool)',
]);
const factory = parseAbi(['function isB20(address) view returns (bool)']);
const feed = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
const oracleReg = parseAbi(['function getOracleParams(address token) view returns (uint256 multiplier, bool paused)']);

const scope = (s) => keccak256(stringToHex(s));
const calls = [];
const add = (label, address, abi, functionName, args = []) => calls.push({ label, address, abi, functionName, args });

for (const fn of ['name','symbol','decimals','totalSupply','multiplier','WAD_PRECISION','uiMultiplier','newUIMultiplier','effectiveAt','pausedFeatures','contractURI','supplyCap']) add(`NVDAc.${fn}`, NVDA, b20, fn);
add('NVDAc.scaledBalanceOf(0x0)', NVDA, b20, 'scaledBalanceOf', [zeroAddress]);
add('NVDAc.toScaledBalance(1e8)', NVDA, b20, 'toScaledBalance', [10n**8n]);
add('NVDAc.toRawBalance(1e8)', NVDA, b20, 'toRawBalance', [10n**8n]);
for (const i of [0,1,2,3]) add(`NVDAc.isPaused(${i})`, NVDA, b20, 'isPaused', [i]);
for (const s of ['TRANSFER_SENDER_POLICY','TRANSFER_RECEIVER_POLICY','TRANSFER_EXECUTOR_POLICY','MINT_RECEIVER_POLICY']) add(`NVDAc.policyId(${s})`, NVDA, b20, 'policyId', [scope(s)]);
add('NVDAc.extraMetadata(issuer)', NVDA, b20, 'extraMetadata', [scope('issuer')]);
add('PolicyRegistry.isAuthorized(0x0,0)', POLICY_REGISTRY, registry, 'isAuthorized', [zeroAddress, 0n]);
add('PolicyRegistry.policyExists(0)', POLICY_REGISTRY, registry, 'policyExists', [0n]);
add('Factory.isB20(NVDAc)', FACTORY, factory, 'isB20', [NVDA]);
add('Factory.isB20(USDC)', FACTORY, factory, 'isB20', [USDC]);
add('Feed.decimals', NVDA_FEED, feed, 'decimals');
add('Feed.description', NVDA_FEED, feed, 'description');
add('Feed.latestRoundData', NVDA_FEED, feed, 'latestRoundData');
add('OracleRegistry.getOracleParams(NVDAc)', ORACLE_REGISTRY, oracleReg, 'getOracleParams', [NVDA]);
add('OracleRegistry.getOracleParams(USDC)', ORACLE_REGISTRY, oracleReg, 'getOracleParams', [USDC]);

const results = await client.multicall({ contracts: calls.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, args })), allowFailure: true });
const fmt = (v) => JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x);
results.forEach((r, i) => {
  const c = calls[i];
  if (r.status === 'success') console.log('OK  ', c.label, '=>', fmt(r.result));
  else console.log('FAIL', c.label, '=>', (r.error?.shortMessage || String(r.error)).split('\n')[0]);
});
const lrd = results[calls.findIndex(c => c.label === 'Feed.latestRoundData')];
if (lrd?.status === 'success') { const [, ans, , upd] = lrd.result; console.log('   NVDA feed price =', formatUnits(ans, 8), 'updatedAt =', new Date(Number(upd)*1000).toISOString(), 'age(s) =', Math.floor(Date.now()/1000 - Number(upd))); }

// second multicall: policyId results -> isAuthorized with the real policy ids
const pidIdx = calls.findIndex(c => c.label === 'NVDAc.policyId(TRANSFER_SENDER_POLICY)');
const pid = results[pidIdx]?.status === 'success' ? results[pidIdx].result : null;
if (pid !== null) {
  const r2 = await client.multicall({ contracts: [
    { address: POLICY_REGISTRY, abi: registry, functionName: 'isAuthorized', args: [zeroAddress, pid] },
    { address: POLICY_REGISTRY, abi: registry, functionName: 'isAuthorized', args: ['0x000000000000000000000000000000000000dEaD', pid] },
    { address: POLICY_REGISTRY, abi: registry, functionName: 'policyExists', args: [pid] },
  ], allowFailure: true });
  console.log('== PolicyRegistry with sender policyId', pid.toString());
  r2.forEach((r, i) => console.log(r.status, ['isAuthorized(0x0,pid)','isAuthorized(dead,pid)','policyExists(pid)'][i], '=>', r.status==='success' ? fmt(r.result) : (r.error?.shortMessage||'').split('\n')[0]));
}
