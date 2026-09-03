import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const POOL = "0x8e740D5Fa742B763cD82159894b9919eD57E4f70";
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C", WETH = "0x4200000000000000000000000000000000000006";
const pAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function liquidity() view returns (uint128)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const [slot0, t0, t1, fee, liq, bal0, bal1] = await Promise.all([
  client.readContract({ address: POOL, abi: pAbi, functionName: "slot0" }),
  client.readContract({ address: POOL, abi: pAbi, functionName: "token0" }),
  client.readContract({ address: POOL, abi: pAbi, functionName: "token1" }),
  client.readContract({ address: POOL, abi: pAbi, functionName: "fee" }),
  client.readContract({ address: POOL, abi: pAbi, functionName: "liquidity" }),
  client.readContract({ address: WETH, abi: erc, functionName: "balanceOf", args: [POOL] }),
  client.readContract({ address: NVDA, abi: erc, functionName: "balanceOf", args: [POOL] }),
]);
const [dec0, dec1] = await Promise.all([client.readContract({ address: t0, abi: erc, functionName: "decimals" }), client.readContract({ address: t1, abi: erc, functionName: "decimals" })]);
const sqrt = Number(slot0[0]) / 2 ** 96;
const priceT1perT0 = sqrt * sqrt * 10 ** (dec0 - dec1); // human units: token1 per 1 token0
const ethUsd = await client.readContract({ address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", abi: feedAbi, functionName: "latestRoundData" }).then((r) => Number(r[1]) / 1e8);
const nvdaFeed = await client.readContract({ address: "0x04689a41629776563E6822F76f2e57D148d28513", abi: feedAbi, functionName: "latestRoundData" }).then((r) => Number(r[1]) / 1e8);
const isT0Weth = t0.toLowerCase() === WETH.toLowerCase();
const nvdaPerWeth = isT0Weth ? priceT1perT0 : 1 / priceT1perT0;
const nvdaUsd = ethUsd / nvdaPerWeth;
console.log(JSON.stringify({ token0: t0, token1: t1, fee: Number(fee), liquidity: String(liq), wethBal: Number(bal0) / 1e18, nvdaBal: Number(bal1) / 1e8, tick: Number(slot0[1]), nvdaPerWeth, ethUsd, poolImpliedNvdaUsd: nvdaUsd, chainlinkNvdaUsd: nvdaFeed, reserveUsd: (Number(bal0) / 1e18) * ethUsd + (Number(bal1) / 1e8) * nvdaUsd }, null, 1));
