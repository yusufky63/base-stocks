// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AutoInvest} from "../src/AutoInvest.sol";

/// @dev Foundry cheatcodes used directly (no forge-std dependency).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function assume(bool) external pure;
}

/* ============================== mock tokens ============================== */

contract MockERC20 {
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// @dev B20-style multiplier. The contract under test must NOT read it: the feeds it prices
    ///      against are total-return (USD per raw token), and the tests pin that it stays ignored.
    uint256 public multiplier = 1e18;

    constructor(string memory s, uint8 d) {
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setMultiplier(uint256 m) external {
        multiplier = m;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A DEX router stand-in: pulls `amountIn` of tokenIn from the caller and pays `amountOut` of
///      tokenOut to `recipient` from its own inventory. Flags model the ways a real route misbehaves.
contract MockRouter {
    enum Mode {
        Honest,
        TakeHalf,
        PayNothing,
        Revert,
        Reenter
    }

    Mode public mode;
    AutoInvest public target;
    uint256 public reenterPlan;

    error RouteDead(string why);

    function setMode(Mode m) external {
        mode = m;
    }

    function setReenter(AutoInvest t, uint256 planId) external {
        target = t;
        reenterPlan = planId;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient) external {
        if (mode == Mode.Revert) revert RouteDead("no liquidity");
        uint256 take = mode == Mode.TakeHalf ? amountIn / 2 : amountIn;
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), take);
        if (mode == Mode.Reenter) {
            AutoInvest.Swap[] memory none = new AutoInvest.Swap[](1);
            target.execute(reenterPlan, none);
        }
        if (mode != Mode.PayNothing) MockERC20(tokenOut).transfer(recipient, amountOut);
    }
}

contract MockFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/* ================================= tests ================================ */

contract AutoInvestTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event PlanCreated(uint256 indexed planId, address indexed owner, uint128 amountPerRun, uint32 interval, uint40 nextRunAt, uint40 expiry, uint16 maxSlippageBps);
    event PlanLegs(uint256 indexed planId, address[] assets, uint16[] weightsBps);
    event PlanExecuted(uint256 indexed planId, uint32 indexed run, uint256 spent, uint40 nextRunAt);
    event LegFilled(uint256 indexed planId, address indexed asset, uint256 spent, uint256 received);
    event LegSkipped(uint256 indexed planId, address indexed asset);
    event PlanStatus(uint256 indexed planId, uint8 status);

    AutoInvest internal auto_;
    MockERC20 internal usdc;
    MockERC20 internal nvda;
    MockERC20 internal aapl;
    MockRouter internal router;
    MockRouter internal rogue;
    MockFeed internal feed;

    address internal constant DEPLOYER = address(0xDE9107);
    address internal constant KEEPER = address(0x6EE9E4);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant STRANGER = address(0xD15EA5E);

    uint128 internal constant PER_RUN = 100e6; // $100
    uint32 internal constant WEEK = 7 days;
    uint16 internal constant SLIPPAGE = 300;
    uint256 internal constant START = 1_800_000_000;

    function setUp() public {
        vm.warp(START);
        usdc = new MockERC20("USDC", 6);
        nvda = new MockERC20("NVDAc", 8);
        aapl = new MockERC20("AAPLc", 8);
        router = new MockRouter();
        rogue = new MockRouter();
        feed = new MockFeed();

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.prank(DEPLOYER);
        auto_ = new AutoInvest(address(usdc), KEEPER, routers, routers);

        usdc.mint(ALICE, 10_000e6);
        vm.prank(ALICE);
        usdc.approve(address(auto_), type(uint256).max);
        nvda.mint(address(router), 1_000e8);
        aapl.mint(address(router), 1_000e8);
        nvda.mint(address(rogue), 1_000e8);
    }

    /* ------------------------------ helpers ------------------------------ */

    function _one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _one16(uint16 a) internal pure returns (uint16[] memory out) {
        out = new uint16[](1);
        out[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        out[0] = a;
        out[1] = b;
    }

    function _two16(uint16 a, uint16 b) internal pure returns (uint16[] memory out) {
        out = new uint16[](2);
        out[0] = a;
        out[1] = b;
    }

    function _plan() internal returns (uint256 id) {
        vm.prank(ALICE);
        id = auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
    }

    function _basket() internal returns (uint256 id) {
        vm.prank(ALICE);
        id = auto_.createPlan(_two(address(nvda), address(aapl)), _two16(6_000, 4_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
    }

    function _swap(MockRouter r, address tokenOut, uint128 amountIn, uint256 amountOut, uint256 minOut) internal view returns (AutoInvest.Swap memory) {
        return AutoInvest.Swap({
            target: address(r),
            spender: address(r),
            amountIn: amountIn,
            minOut: minOut,
            data: abi.encodeCall(MockRouter.swap, (address(usdc), tokenOut, amountIn, amountOut, ALICE))
        });
    }

    function _single(AutoInvest.Swap memory s) internal pure returns (AutoInvest.Swap[] memory out) {
        out = new AutoInvest.Swap[](1);
        out[0] = s;
    }

    function _pair(AutoInvest.Swap memory a, AutoInvest.Swap memory b) internal pure returns (AutoInvest.Swap[] memory out) {
        out = new AutoInvest.Swap[](2);
        out[0] = a;
        out[1] = b;
    }

    function _run(uint256 id, AutoInvest.Swap[] memory swaps) internal {
        vm.prank(KEEPER);
        auto_.execute(id, swaps);
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    function _status(uint256 id) internal view returns (uint8 status, uint40 nextRunAt, uint32 runs) {
        (,,, nextRunAt,,, runs,, status) = auto_.plans(id);
    }

    /* ------------------------------- create ------------------------------ */

    function test_create_stores_plan_legs_and_index() public {
        vm.expectEmit(true, false, false, true);
        emit PlanLegs(1, _two(address(nvda), address(aapl)), _two16(6_000, 4_000));
        vm.expectEmit(true, true, false, true);
        emit PlanCreated(1, ALICE, PER_RUN, WEEK, uint40(START), 0, SLIPPAGE);
        uint256 id = _basket();
        _eq(id, 1, "first plan id");
        (address owner, uint128 amount, uint32 interval, uint40 next, uint40 expiry, uint16 slip, uint32 runs, uint40 last, uint8 status) = auto_.plans(id);
        require(owner == ALICE, "owner");
        _eq(amount, PER_RUN, "amount");
        _eq(interval, WEEK, "interval");
        _eq(next, START, "due now");
        _eq(expiry, 0, "no expiry");
        _eq(slip, SLIPPAGE, "slippage");
        _eq(runs, 0, "runs");
        _eq(last, 0, "never ran");
        _eq(status, 0, "active");
        AutoInvest.Leg[] memory legs = auto_.legsOf(id);
        _eq(legs.length, 2, "legs");
        require(legs[0].asset == address(nvda) && legs[0].weightBps == 6_000, "leg 0");
        require(legs[1].asset == address(aapl) && legs[1].weightBps == 4_000, "leg 1");
        uint256[] memory mine = auto_.plansOf(ALICE);
        _eq(mine.length, 1, "index");
        _eq(mine[0], id, "index id");
        require(auto_.isDue(id), "due at creation");
    }

    function test_create_honours_first_run_and_expiry() public {
        uint40 first = uint40(START + 3 days);
        uint40 expiry = uint40(START + 30 days);
        vm.prank(ALICE);
        uint256 id = auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, first, expiry, SLIPPAGE);
        (,,, uint40 next, uint40 exp,,,,) = auto_.plans(id);
        _eq(next, first, "first run");
        _eq(exp, expiry, "expiry");
        require(!auto_.isDue(id), "not due yet");
        vm.warp(first);
        require(auto_.isDue(id), "due at first run");
        vm.warp(expiry + 1);
        require(!auto_.isDue(id), "expired");
    }

    function test_create_rejects_bad_legs() public {
        vm.startPrank(ALICE);
        vm.expectRevert(AutoInvest.BadLegs.selector);
        auto_.createPlan(new address[](0), new uint16[](0), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadLegs.selector);
        auto_.createPlan(_one(address(nvda)), _two16(5_000, 5_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadLegs.selector);
        auto_.createPlan(_one(address(0)), _one16(10_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadLegs.selector);
        auto_.createPlan(_one(address(usdc)), _one16(10_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        address[] memory many = new address[](13);
        uint16[] memory w = new uint16[](13);
        for (uint256 i = 0; i < 13; i++) {
            many[i] = address(uint160(0x1000 + i));
            w[i] = 769;
        }
        vm.expectRevert(AutoInvest.BadLegs.selector);
        auto_.createPlan(many, w, PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.stopPrank();
    }

    function test_create_rejects_bad_weights() public {
        vm.startPrank(ALICE);
        vm.expectRevert(AutoInvest.BadWeights.selector);
        auto_.createPlan(_one(address(nvda)), _one16(9_999), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadWeights.selector);
        auto_.createPlan(_two(address(nvda), address(aapl)), _two16(10_000, 0), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.DuplicateAsset.selector);
        auto_.createPlan(_two(address(nvda), address(nvda)), _two16(5_000, 5_000), PER_RUN, WEEK, 0, 0, SLIPPAGE);
        vm.stopPrank();
    }

    function test_create_rejects_bad_terms() public {
        vm.startPrank(ALICE);
        vm.expectRevert(AutoInvest.BadAmount.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), 999_999, WEEK, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadInterval.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, 59 minutes, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadInterval.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, 367 days, 0, 0, SLIPPAGE);
        vm.expectRevert(AutoInvest.BadExpiry.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, uint40(START), SLIPPAGE);
        vm.expectRevert(AutoInvest.BadExpiry.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, uint40(START + 6 * 365 days), SLIPPAGE);
        vm.expectRevert(AutoInvest.BadExpiry.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, uint40(START + 40 days), uint40(START + 30 days), SLIPPAGE);
        vm.expectRevert(AutoInvest.BadSlippage.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, 0, 9);
        vm.expectRevert(AutoInvest.BadSlippage.selector);
        auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, 0, 2_001);
        vm.stopPrank();
    }

    /* ------------------------------- execute ----------------------------- */

    function test_execute_moves_usdc_delivers_stock_and_schedules_next() public {
        uint256 id = _plan();
        vm.expectEmit(true, true, false, true);
        emit LegFilled(id, address(nvda), PER_RUN, 5e7);
        vm.expectEmit(true, true, false, true);
        emit PlanExecuted(id, 1, PER_RUN, uint40(START + WEEK));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 4.9e7)));

        _eq(usdc.balanceOf(ALICE), 10_000e6 - PER_RUN, "alice paid one run");
        _eq(usdc.balanceOf(address(router)), PER_RUN, "router got the usdc");
        _eq(usdc.balanceOf(address(auto_)), 0, "contract keeps nothing");
        _eq(nvda.balanceOf(ALICE), 5e7, "alice got the stock");
        _eq(nvda.balanceOf(address(auto_)), 0, "contract never holds stock");
        _eq(usdc.allowance(address(auto_), address(router)), 0, "approval reset");
        (uint8 status, uint40 next, uint32 runs) = _status(id);
        _eq(status, 0, "still active");
        _eq(next, START + WEEK, "next anchor");
        _eq(runs, 1, "one run");
        require(!auto_.isDue(id), "not due again");
    }

    function test_execute_basket_splits_by_weight_and_skips_zero_legs() public {
        uint256 id = _basket();
        AutoInvest.Swap memory skip;
        skip.amountIn = 0;
        vm.expectEmit(true, true, false, true);
        emit LegFilled(id, address(nvda), 60e6, 3e7);
        vm.expectEmit(true, true, false, true);
        emit LegSkipped(id, address(aapl));
        _run(id, _pair(_swap(router, address(nvda), 60e6, 3e7, 3e7), skip));
        _eq(usdc.balanceOf(ALICE), 10_000e6 - 60e6, "only the filled leg is charged");
        _eq(nvda.balanceOf(ALICE), 3e7, "nvda leg");
        _eq(aapl.balanceOf(ALICE), 0, "aapl skipped");
    }

    function test_execute_rejects_leg_over_its_weight() public {
        uint256 id = _basket();
        AutoInvest.Swap memory skip;
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.LegTooLarge.selector, 0));
        _run(id, _pair(_swap(router, address(nvda), 60e6 + 1, 3e7, 0), skip));
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.LegTooLarge.selector, 1));
        _run(id, _pair(_swap(router, address(nvda), 60e6, 3e7, 0), _swap(router, address(aapl), 40e6 + 1, 2e7, 0)));
    }

    function test_execute_rejects_all_legs_skipped_and_wrong_count() public {
        uint256 id = _basket();
        AutoInvest.Swap memory skip;
        vm.expectRevert(AutoInvest.NothingToBuy.selector);
        _run(id, _pair(skip, skip));
        vm.expectRevert(AutoInvest.BadSwaps.selector);
        _run(id, _single(_swap(router, address(nvda), 60e6, 3e7, 0)));
    }

    function test_execute_waits_for_the_interval() public {
        uint256 id = _plan();
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.expectRevert(AutoInvest.NotDue.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.warp(START + WEEK - 1);
        vm.expectRevert(AutoInvest.NotDue.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.warp(START + WEEK);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        (, uint40 next, uint32 runs) = _status(id);
        _eq(runs, 2, "two runs");
        _eq(next, START + 2 * WEEK, "anchor moves on the grid");
    }

    /// Away for five weeks and a bit: one run is owed, and the anchor stays on the original weekday.
    function test_execute_catches_up_without_stacking_runs() public {
        uint256 id = _plan();
        vm.warp(START + 5 * WEEK + 2 days);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        (, uint40 next,) = _status(id);
        _eq(next, START + 6 * WEEK, "first grid point after now");
        vm.expectRevert(AutoInvest.NotDue.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        _eq(usdc.balanceOf(ALICE), 10_000e6 - PER_RUN, "one run charged, not five");
    }

    function test_next_anchor_is_always_in_the_future() public view {
        _eq(auto_.nextAnchor(uint40(START), WEEK, START), START + WEEK, "exact");
        _eq(auto_.nextAnchor(uint40(START), WEEK, START + WEEK), START + 2 * WEEK, "on the boundary");
        _eq(auto_.nextAnchor(uint40(START), WEEK, START + 100 * WEEK + 1), START + 101 * WEEK, "far away");
        _eq(auto_.nextAnchor(uint40(START), 1 hours, START + 3 * 365 days), START + (3 * 365 * 24 + 1) * 1 hours, "hourly for years");
    }

    function test_execute_requires_keeper_or_plan_owner() public {
        uint256 id = _plan();
        vm.prank(STRANGER);
        vm.expectRevert(AutoInvest.NotKeeper.selector);
        auto_.execute(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.prank(ALICE);
        auto_.execute(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        _eq(nvda.balanceOf(ALICE), 5e7, "owner may run her own plan");
        vm.expectRevert(AutoInvest.PlanUnknown.selector);
        _run(99, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
    }

    function test_pause_resume_and_cancel() public {
        uint256 id = _plan();
        vm.prank(STRANGER);
        vm.expectRevert(AutoInvest.NotPlanOwner.selector);
        auto_.setPlanActive(id, false);

        vm.prank(ALICE);
        vm.expectEmit(true, false, false, true);
        emit PlanStatus(id, 1);
        auto_.setPlanActive(id, false);
        vm.expectRevert(AutoInvest.PlanNotActive.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        require(!auto_.isDue(id), "paused is not due");

        // Paused across three weeks: on resume exactly one run is owed.
        vm.warp(START + 3 * WEEK + 1 days);
        vm.prank(ALICE);
        auto_.setPlanActive(id, true);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        (, uint40 next,) = _status(id);
        _eq(next, START + 4 * WEEK, "resumed on the grid");

        vm.prank(ALICE);
        auto_.cancelPlan(id);
        vm.warp(START + 10 * WEEK);
        vm.expectRevert(AutoInvest.PlanNotActive.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.startPrank(ALICE);
        vm.expectRevert(AutoInvest.PlanIsCancelled.selector);
        auto_.setPlanActive(id, true);
        vm.expectRevert(AutoInvest.PlanIsCancelled.selector);
        auto_.cancelPlan(id);
        vm.expectRevert(AutoInvest.PlanIsCancelled.selector);
        auto_.updatePlan(id, PER_RUN, WEEK, 0, SLIPPAGE);
        vm.stopPrank();
    }

    function test_execute_rejects_after_expiry() public {
        vm.prank(ALICE);
        uint256 id = auto_.createPlan(_one(address(nvda)), _one16(10_000), PER_RUN, WEEK, 0, uint40(START + 10 days), SLIPPAGE);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.warp(START + 11 days);
        vm.expectRevert(AutoInvest.PlanExpired.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
    }

    function test_execute_rejects_routes_outside_the_allowlist() public {
        uint256 id = _plan();
        vm.expectRevert(AutoInvest.RouteNotAllowed.selector);
        _run(id, _single(_swap(rogue, address(nvda), PER_RUN, 5e7, 0)));
        AutoInvest.Swap memory s = _swap(router, address(nvda), PER_RUN, 5e7, 0);
        s.spender = address(rogue);
        vm.expectRevert(AutoInvest.RouteNotAllowed.selector);
        _run(id, _single(s));
        _eq(usdc.balanceOf(ALICE), 10_000e6, "nothing left the wallet");
    }

    function test_execute_enforces_min_out_and_nonzero_output() public {
        uint256 id = _plan();
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.TooLittleReceived.selector, 0, 4.8e7, 5e7));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 4.8e7, 5e7)));

        router.setMode(MockRouter.Mode.PayNothing);
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.TooLittleReceived.selector, 0, 0, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        _eq(usdc.balanceOf(ALICE), 10_000e6, "a failed run costs nothing");
    }

    function test_execute_returns_usdc_the_router_did_not_take() public {
        uint256 id = _plan();
        router.setMode(MockRouter.Mode.TakeHalf);
        vm.expectEmit(true, true, false, true);
        emit PlanExecuted(id, 1, PER_RUN / 2, uint40(START + WEEK));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        _eq(usdc.balanceOf(ALICE), 10_000e6 - PER_RUN / 2, "only what was swapped is gone");
        _eq(usdc.balanceOf(address(auto_)), 0, "nothing stranded");
    }

    function test_execute_bubbles_the_router_revert() public {
        uint256 id = _plan();
        router.setMode(MockRouter.Mode.Revert);
        vm.expectRevert(abi.encodeWithSelector(MockRouter.RouteDead.selector, "no liquidity"));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
    }

    function test_execute_blocks_reentrancy() public {
        uint256 id = _plan();
        router.setMode(MockRouter.Mode.Reenter);
        router.setReenter(auto_, id);
        vm.expectRevert(AutoInvest.Reentered.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
    }

    function test_execute_fails_cleanly_without_allowance_or_balance() public {
        uint256 id = _plan();
        vm.prank(ALICE);
        usdc.approve(address(auto_), 0);
        vm.expectRevert(AutoInvest.TransferFailed.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));

        vm.prank(ALICE);
        usdc.approve(address(auto_), type(uint256).max);
        vm.prank(ALICE);
        usdc.transfer(BOB, 10_000e6 - 1);
        vm.expectRevert(AutoInvest.TransferFailed.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
    }

    /* ---------------------------- reference floor ------------------------ */

    /// $100 at $200 a share is half a share; the floor is that less 3%.
    function test_quote_floor_matches_reference_math() public {
        feed.set(200e8, START);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 48_500_000, "half a share less 3%");
        _eq(auto_.quoteFloor(address(nvda), 100e6, 0), 50_000_000, "exactly half a share at 0%");
        _eq(auto_.quoteFloor(address(aapl), 100e6, SLIPPAGE), 0, "no feed, no floor");
    }

    /// The Coinbase feeds are total-return: the answer is already USD per RAW token. After a 2:1
    /// split the multiplier doubles and the feed halves on its own, so the raw units $100 buys at a
    /// given answer never depend on the multiplier. (The first deployment divided by it once more,
    /// which would have loosened the floor by the multiplier after the first split.)
    function test_quote_floor_ignores_the_multiplier() public {
        feed.set(200e8, START);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        _eq(auto_.quoteFloor(address(nvda), 100e6, 0), 50_000_000, "at 1e18");
        nvda.setMultiplier(2e18);
        _eq(auto_.quoteFloor(address(nvda), 100e6, 0), 50_000_000, "same raw units at 2e18");
        nvda.setMultiplier(5e17);
        _eq(auto_.quoteFloor(address(nvda), 100e6, 0), 50_000_000, "same raw units at 5e17");
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 48_500_000, "slippage still applies");
    }

    function test_quote_floor_is_zero_when_the_feed_cannot_be_trusted() public {
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        feed.set(0, START);
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 0, "zero answer");
        feed.set(-1, START);
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 0, "negative answer");
        feed.set(200e8, START);
        vm.warp(START + 4 days + 1);
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 0, "older than four days");
        vm.warp(START + 4 days);
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 48_500_000, "a Friday close still counts on Tuesday");
        // A feed that is not a feed at all (no latestRoundData) is treated as absent.
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(usdc));
        _eq(auto_.quoteFloor(address(nvda), 100e6, SLIPPAGE), 0, "broken feed");
    }

    function test_execute_enforces_the_reference_floor() public {
        uint256 id = _plan();
        feed.set(200e8, START);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        // The keeper's own minOut is lax, but the chain knows $100 should buy about half a share.
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.TooLittleReceived.selector, 0, 4e7, 48_500_000));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 4e7, 1)));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 48_500_000, 1)));
        _eq(nvda.balanceOf(ALICE), 48_500_000, "exactly the floor passes");
    }

    /// A stock with a feed registered does not run while that feed is unusable, however lax the
    /// keeper's minOut: a leaked keeper key must not be able to route a leg at minOut 1 during an
    /// outage. The run costs the owner nothing and resumes as soon as the feed is healthy again.
    function test_execute_refuses_a_leg_whose_feed_is_unusable() public {
        uint256 id = _plan();
        feed.set(200e8, START);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));

        // Older than MAX_FEED_AGE.
        vm.warp(START + 4 days + 1);
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.FloorUnavailable.selector, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 1)));
        // Non-positive answers.
        feed.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.FloorUnavailable.selector, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 1)));
        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.FloorUnavailable.selector, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 1)));
        // A feed that does not answer at all.
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(usdc));
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.FloorUnavailable.selector, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 1)));
        _eq(usdc.balanceOf(ALICE), 10_000e6, "nothing left the wallet");
        _eq(nvda.balanceOf(ALICE), 0, "nothing was bought");
        (, uint40 next, uint32 runs) = _status(id);
        _eq(runs, 0, "no run recorded");
        _eq(next, START, "still due");

        // Healthy again: the same swap runs, judged against the floor as usual.
        feed.set(200e8, block.timestamp);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 1)));
        _eq(nvda.balanceOf(ALICE), 5e7, "bought once the feed is back");
    }

    /// No feed registered: today's behaviour, the keeper's minOut and a non-zero delivery decide.
    function test_execute_without_a_feed_still_runs_on_min_out() public {
        uint256 id = _plan();
        require(auto_.feeds(address(nvda)) == address(0), "no feed");
        _eq(auto_.quoteFloor(address(nvda), PER_RUN, SLIPPAGE), 0, "no floor either");
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 1, 1)));
        _eq(nvda.balanceOf(ALICE), 1, "minOut alone decided");
    }

    /// An outage on one stock's feed holds back only the legs that buy that stock: the keeper skips
    /// them (amountIn 0) and the rest of the basket runs; filling the held leg reverts the run.
    function test_feed_outage_blocks_only_the_legs_that_use_the_feed() public {
        uint256 id = _basket();
        feed.set(200e8, START);
        vm.prank(DEPLOYER);
        auto_.setFeed(address(nvda), address(feed));
        vm.warp(START + 4 days + 1); // nvda's feed is now stale; aapl has none

        AutoInvest.Swap memory skip;
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.FloorUnavailable.selector, 0));
        _run(id, _pair(_swap(router, address(nvda), 60e6, 3e7, 1), _swap(router, address(aapl), 40e6, 2e7, 1)));

        vm.expectEmit(true, true, false, true);
        emit LegSkipped(id, address(nvda));
        vm.expectEmit(true, true, false, true);
        emit LegFilled(id, address(aapl), 40e6, 2e7);
        _run(id, _pair(skip, _swap(router, address(aapl), 40e6, 2e7, 1)));
        _eq(usdc.balanceOf(ALICE), 10_000e6 - 40e6, "only the feedless leg was charged");
        _eq(nvda.balanceOf(ALICE), 0, "held leg bought nothing");
        _eq(aapl.balanceOf(ALICE), 2e7, "other leg filled");
    }

    /* ------------------------------- operator ---------------------------- */

    function test_allowlist_additions_wait_a_day_removals_do_not() public {
        uint256 id = _plan();
        vm.startPrank(DEPLOYER);
        vm.expectRevert(AutoInvest.NotProposed.selector);
        auto_.applyAllowlist(AutoInvest.Kind.Router, address(rogue));
        auto_.proposeAllowlist(AutoInvest.Kind.Router, address(rogue));
        auto_.proposeAllowlist(AutoInvest.Kind.Spender, address(rogue));
        vm.warp(START + 24 hours - 1);
        vm.expectRevert(AutoInvest.DelayNotPassed.selector);
        auto_.applyAllowlist(AutoInvest.Kind.Router, address(rogue));
        vm.warp(START + 24 hours);
        auto_.applyAllowlist(AutoInvest.Kind.Router, address(rogue));
        auto_.applyAllowlist(AutoInvest.Kind.Spender, address(rogue));
        vm.stopPrank();
        require(auto_.routerAllowed(address(rogue)) && auto_.spenderAllowed(address(rogue)), "listed after the delay");
        _run(id, _single(_swap(rogue, address(nvda), PER_RUN, 5e7, 0)));

        vm.prank(DEPLOYER);
        auto_.revokeAllowlist(AutoInvest.Kind.Router, address(router));
        require(!auto_.routerAllowed(address(router)), "removed at once");
        vm.warp(START + WEEK + 1 days);
        vm.expectRevert(AutoInvest.RouteNotAllowed.selector);
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        // A proposal that was revoked cannot be applied later without a fresh announcement.
        vm.prank(DEPLOYER);
        vm.expectRevert(AutoInvest.NotProposed.selector);
        auto_.applyAllowlist(AutoInvest.Kind.Router, address(router));
    }

    function test_only_the_operator_administers() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.setKeeper(STRANGER);
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.proposeAllowlist(AutoInvest.Kind.Router, STRANGER);
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.revokeAllowlist(AutoInvest.Kind.Router, address(router));
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.setFeed(address(nvda), address(feed));
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.transferOwnership(STRANGER);
        vm.stopPrank();

        vm.prank(DEPLOYER);
        vm.expectRevert(AutoInvest.ZeroAddress.selector);
        auto_.setKeeper(address(0));
    }

    function test_keeper_rotation_and_two_step_ownership() public {
        uint256 id = _plan();
        vm.prank(DEPLOYER);
        auto_.setKeeper(BOB);
        vm.prank(KEEPER);
        vm.expectRevert(AutoInvest.NotKeeper.selector);
        auto_.execute(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        vm.prank(BOB);
        auto_.execute(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));

        vm.prank(DEPLOYER);
        auto_.transferOwnership(BOB);
        require(auto_.owner() == DEPLOYER, "unchanged until accepted");
        vm.prank(STRANGER);
        vm.expectRevert(AutoInvest.NotOwner.selector);
        auto_.acceptOwnership();
        vm.prank(BOB);
        auto_.acceptOwnership();
        require(auto_.owner() == BOB && auto_.pendingOwner() == address(0), "accepted");
    }

    function test_update_plan_changes_terms_only_for_the_owner() public {
        uint256 id = _plan();
        vm.prank(STRANGER);
        vm.expectRevert(AutoInvest.NotPlanOwner.selector);
        auto_.updatePlan(id, 50e6, 1 days, 0, 100);
        vm.startPrank(ALICE);
        vm.expectRevert(AutoInvest.BadAmount.selector);
        auto_.updatePlan(id, 1, 1 days, 0, 100);
        auto_.updatePlan(id, 50e6, 1 days, uint40(START + 60 days), 100);
        vm.stopPrank();
        (, uint128 amount, uint32 interval,, uint40 expiry, uint16 slip,,,) = auto_.plans(id);
        _eq(amount, 50e6, "amount");
        _eq(interval, 1 days, "interval");
        _eq(expiry, START + 60 days, "expiry");
        _eq(slip, 100, "slippage");
        vm.expectRevert(abi.encodeWithSelector(AutoInvest.LegTooLarge.selector, 0));
        _run(id, _single(_swap(router, address(nvda), PER_RUN, 5e7, 0)));
        _run(id, _single(_swap(router, address(nvda), 50e6, 2.5e7, 0)));
    }

    function test_constructor_rejects_zero_addresses() public {
        address[] memory none = new address[](0);
        vm.expectRevert(AutoInvest.ZeroAddress.selector);
        new AutoInvest(address(0), KEEPER, none, none);
        vm.expectRevert(AutoInvest.ZeroAddress.selector);
        new AutoInvest(address(usdc), address(0), none, none);
    }

    /* -------------------------------- fuzz ------------------------------- */

    /// Whatever the keeper asks for, a run can never charge more than the plan allows per leg.
    function testFuzz_execute_never_exceeds_the_plan(uint128 a, uint128 b) public {
        uint256 id = _basket();
        AutoInvest.Swap[] memory swaps = _pair(_swap(router, address(nvda), a, 1, 0), _swap(router, address(aapl), b, 1, 0));
        bool overA = a > 60e6;
        bool overB = b > 40e6;
        if (overA || overB) {
            vm.expectRevert(abi.encodeWithSelector(AutoInvest.LegTooLarge.selector, overA ? 0 : 1));
            _run(id, swaps);
            return;
        }
        if (a == 0 && b == 0) {
            vm.expectRevert(AutoInvest.NothingToBuy.selector);
            _run(id, swaps);
            return;
        }
        _run(id, swaps);
        _eq(usdc.balanceOf(ALICE), 10_000e6 - uint256(a) - uint256(b), "charged exactly what was swapped");
        require(uint256(a) + uint256(b) <= PER_RUN, "never above the run");
    }
}
