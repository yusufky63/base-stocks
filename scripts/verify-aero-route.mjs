import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
const client = createPublicClient({ chain: base, transport: http('https://base-rpc.publicnode.com') });
const ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const abi = parseAbi(['function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)','function defaultFactory() view returns (address)']);
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', NVDA='0xb20000000000000000000078ee7ce2fE4908108C', FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
try { const f = await client.readContract({ address: ROUTER, abi, functionName: 'defaultFactory' }); console.log('defaultFactory', f); } catch (e) { console.log('defaultFactory FAIL', e.shortMessage); }
try { const out = await client.readContract({ address: ROUTER, abi, functionName: 'getAmountsOut', args: [25000000n, [{ from: USDC, to: NVDA, stable: false, factory: FACTORY }]] }); console.log('amounts', out.map(String)); } catch (e) { console.log('getAmountsOut FAIL', e.shortMessage); }
