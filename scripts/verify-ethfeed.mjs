import { createPublicClient, http, fallback, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
const client = createPublicClient({ chain: base, transport: fallback([http('https://base-rpc.publicnode.com'), http('https://mainnet.base.org')]) });
const abi = parseAbi(['function description() view returns (string)','function decimals() view returns (uint8)','function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
for (const feed of ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70']) {
  try { const [d, dec, r] = await Promise.all([client.readContract({address:feed,abi,functionName:'description'}), client.readContract({address:feed,abi,functionName:'decimals'}), client.readContract({address:feed,abi,functionName:'latestRoundData'})]); console.log(feed, d, dec, formatUnits(r[1], dec), 'age', Math.floor(Date.now()/1000-Number(r[3]))); } catch (e) { console.log('FAIL', feed, (e.shortMessage||e.message).split('\n')[0]); }
}
