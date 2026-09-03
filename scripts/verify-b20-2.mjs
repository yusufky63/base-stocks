import { createPublicClient, http, fallback, parseAbi, zeroAddress, keccak256, stringToHex } from 'viem';
import { base } from 'viem/chains';
const client = createPublicClient({ chain: base, transport: fallback([http('https://base-rpc.publicnode.com'), http('https://base.llamarpc.com'), http('https://mainnet.base.org')]) });
const POLICY_REGISTRY = '0x8453000000000000000000000000000000000002';
const ORACLE_REGISTRY = '0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD';
const STOCKS = {
  AAPLc:'0xb200000000000000000000C2e324d24d7eEcd1fb', AMZNc:'0xb200000000000000000000d9192b6B456483C2E8', COINc:'0xb200000000000000000000c85a31389D71F3ecfb',
  CRCLc:'0xB20000000000000000000019f6E7C675b73C2e4D', GOOGLc:'0xb2000000000000000000002D0BA3164cc74f58B7', INTCc:'0xB2000000000000000000004AFF16039bA04bdFBc',
  METAc:'0xb2000000000000000000008bC8786B856E61707C', MSFTc:'0xB200000000000000000000Ab99cFa739E253872B', MSTRc:'0xb2000000000000000000004884b426556b92883d',
  NVDAc:'0xb20000000000000000000078ee7ce2fE4908108C', SNDKc:'0xb200000000000000000000397293Cb8cda9a10c5', SPCXc:'0xb2000000000000000000007b9fcbd005511aCBd5', TSLAc:'0xb2000000000000000000001e800a7f5189430cD0',
};
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reg = parseAbi([
  'function isAuthorized(uint64 policyId, address account) view returns (bool)',
  'function isAuthorized(address account, uint64 policyId) view returns (bool)',
  'function isAuthorized(bytes32 policyId, address account) view returns (bool)',
  'function isAuthorized(uint256 policyId, address account) view returns (bool)',
  'function policyExists(uint64) view returns (bool)',
  'function policyAdmin(uint64) view returns (address)',
]);
const b20 = parseAbi(['function symbol() view returns (string)','function decimals() view returns (uint8)','function multiplier() view returns (uint256)','function policyId(bytes32) view returns (uint256)']);
const oracleReg = parseAbi(['function getOracleParams(address token) view returns (uint256 multiplier, bool paused)']);
const fmt = (v) => JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x);

const pid = 5n; const acct = zeroAddress;
const variants = [
  ['isAuthorized(uint64,address)', [pid, acct]], ['isAuthorized(address,uint64)', [acct, pid]],
  ['isAuthorized(bytes32,address)', ['0x0000000000000000000000000000000000000000000000000000000000000005', acct]],
  ['isAuthorized(uint256,address)', [pid, acct]],
];
const rc = [];
// viem needs unique function selection with overloads; build raw calls with encodeFunctionData instead
import { encodeFunctionData, decodeFunctionResult, toFunctionSelector } from 'viem';
for (const [sig, args] of variants) {
  const selector = toFunctionSelector(`function ${sig} view returns (bool)`);
  const abiItem = reg.find(a => a.type === 'function' && a.name === 'isAuthorized' && toFunctionSelector(a) === selector);
  const data = encodeFunctionData({ abi: [abiItem], functionName: 'isAuthorized', args });
  try { const r = await client.call({ to: POLICY_REGISTRY, data }); console.log('OK  ', sig, selector, '=>', r.data); }
  catch (e) { console.log('FAIL', sig, selector, '=>', (e.shortMessage||e.message).split('\n')[0]); }
}
for (const fn of ['policyExists','policyAdmin']) {
  try { const r = await client.readContract({ address: POLICY_REGISTRY, abi: reg, functionName: fn, args: [pid] }); console.log('OK  ', fn+'(uint64 5)', '=>', fmt(r)); }
  catch (e) { console.log('FAIL', fn+'(uint64 5)', '=>', (e.shortMessage||e.message).split('\n')[0]); }
}
const code = await client.getCode({ address: POLICY_REGISTRY }); console.log('PolicyRegistry code len', code?.length ?? 0);

const contracts = [];
for (const [sym, addr] of Object.entries(STOCKS)) {
  contracts.push({ address: addr, abi: b20, functionName: 'symbol' }, { address: addr, abi: b20, functionName: 'decimals' }, { address: addr, abi: b20, functionName: 'multiplier' }, { address: addr, abi: b20, functionName: 'policyId', args: [keccak256(stringToHex('TRANSFER_SENDER_POLICY'))] }, { address: ORACLE_REGISTRY, abi: oracleReg, functionName: 'getOracleParams', args: [addr] });
}
contracts.push({ address: USDC, abi: b20, functionName: 'decimals' });
const res = await client.multicall({ contracts, allowFailure: true });
let i = 0;
for (const [sym] of Object.entries(STOCKS)) {
  const row = res.slice(i, i+5).map(r => r.status === 'success' ? fmt(r.result) : 'ERR'); i += 5;
  console.log(sym.padEnd(7), row.join(' | '));
}
console.log('USDC decimals', fmt(res[i].result));
