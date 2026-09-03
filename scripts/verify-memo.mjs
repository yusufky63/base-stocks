import { createPublicClient, http, fallback, encodeFunctionData, parseAbi, zeroAddress, toFunctionSelector } from 'viem';
import { base } from 'viem/chains';
const client = createPublicClient({ chain: base, transport: fallback([http('https://base-rpc.publicnode.com'), http('https://base.llamarpc.com'), http('https://mainnet.base.org')]) });
const NVDA = '0xb20000000000000000000078ee7ce2fE4908108C';
const holder = '0x000000000000000000000000000000000000dEaD';
const variants = [
  ['bytes32', parseAbi(['function transferWithMemo(address to, uint256 amount, bytes32 memo)']), [holder, 0n, '0x' + '11'.repeat(32)]],
  ['bytes',   parseAbi(['function transferWithMemo(address to, uint256 amount, bytes memo)']),   [holder, 0n, '0x1122']],
  ['string',  parseAbi(['function transferWithMemo(address to, uint256 amount, string memo)']),  [holder, 0n, 'gift']],
];
for (const [label, abi, args] of variants) {
  const data = encodeFunctionData({ abi, functionName: 'transferWithMemo', args });
  const sel = toFunctionSelector(abi[0]);
  try { const r = await client.call({ account: zeroAddress, to: NVDA, data }); console.log('OK  ', label, sel, '=>', r.data); }
  catch (e) { const d = e.cause?.data ?? e.data ?? e.details ?? ''; console.log('FAIL', label, sel, '=>', (e.shortMessage||e.message).split('\n')[0], '| raw:', JSON.stringify(d).slice(0,120)); }
}
// also test plain transfer from zero address for comparison
const t = encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']), functionName: 'transfer', args: [holder, 0n] });
try { const r = await client.call({ account: zeroAddress, to: NVDA, data: t }); console.log('OK   transfer(zero->dead,0) =>', r.data); }
catch (e) { console.log('FAIL transfer =>', (e.shortMessage||e.message).split('\n')[0], '| raw:', JSON.stringify(e.cause?.data ?? e.data ?? '').slice(0,120)); }
