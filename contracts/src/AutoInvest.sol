// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 surface. USDC on Base returns a bool; B20 stocks are plain ERC-20s
///         with issuer transfer policies, and the contract never holds them — a swap's output
///         goes straight to the plan owner, who is already an authorised holder.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice B20 tokenized stocks scale raw units to share-equivalents: scaled = raw × multiplier / 1e18.
///         A corporate action changes the multiplier, not anyone's raw balance.
interface IB20Multiplier {
    function multiplier() external view returns (uint256);
}

/// @notice Chainlink AggregatorV3 — the "Coinbase <TICKER>" total-return feeds price one SHARE.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/**
 * @title  AutoInvest
 * @notice Recurring stock purchases that run without the owner being present. A plan says how much
 *         USDC to spend per run, how often, into which stocks and in what proportion. A keeper (the
 *         BStocks operator) — or the plan owner — triggers a run when it is due: the contract pulls
 *         exactly one run's USDC from the owner's wallet under a normal ERC-20 allowance, swaps it
 *         through an allow-listed DEX router with the owner as recipient, checks the owner actually
 *         received at least the promised output, and returns any USDC the router did not take.
 *
 * @dev    What the chain enforces, so the keeper never has to be trusted with more than timing and
 *         route choice:
 *         - amount: never more than `amountPerRun` per run, never more than a leg's weight per leg;
 *         - cadence: a run can only start once `nextRunAt` has passed, and the next anchor moves
 *           forward on the plan's own schedule (a plan paused for two months owes one run, not eight);
 *         - destination: routers and spenders are allow-listed; additions take effect 24 hours after
 *           they are announced onchain, removals at once;
 *         - output: the owner's stock balance must grow by at least the keeper's `minOut`, by more
 *           than zero, and — when a Chainlink feed is registered for the stock — by at least the
 *           reference price less the plan's own slippage tolerance;
 *         - custody: USDC enters and leaves within one transaction; the contract never holds stock.
 *         The owner can pause, resume, edit or cancel a plan at any time, and revoking the USDC
 *         allowance stops everything regardless of what this contract thinks.
 */
contract AutoInvest {
    enum Kind {
        Router,
        Spender
    }

    struct Plan {
        address owner;
        uint128 amountPerRun;
        uint32 interval;
        uint40 nextRunAt;
        /// @notice 0 = no expiry.
        uint40 expiry;
        uint16 maxSlippageBps;
        uint32 runs;
        uint40 lastRunAt;
        /// @notice 0 active, 1 paused, 2 cancelled (terminal).
        uint8 status;
    }

    struct Leg {
        address asset;
        uint16 weightBps;
    }

    /// @notice One leg's swap, built offchain from an aggregator quote with the plan owner as recipient.
    struct Swap {
        address target;
        address spender;
        uint128 amountIn;
        uint256 minOut;
        bytes data;
    }

    IERC20 public immutable USDC;
    uint256 public immutable USDC_UNIT;
    uint256 public constant WAD = 1e18;
    uint16 public constant TOTAL_BPS = 10_000;
    uint256 public constant MAX_LEGS = 12;
    uint32 public constant MIN_INTERVAL = 1 hours;
    uint32 public constant MAX_INTERVAL = 366 days;
    uint256 public constant MAX_PLAN_DURATION = 5 * 365 days;
    uint16 public constant MIN_SLIPPAGE_BPS = 10;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint256 public constant ALLOWLIST_DELAY = 24 hours;
    /// @notice Stock feeds update on weekdays; a Friday close must still count on Monday morning.
    uint256 public constant MAX_FEED_AGE = 4 days;

    address public owner;
    address public pendingOwner;
    address public keeper;

    mapping(address => bool) public routerAllowed;
    mapping(address => bool) public spenderAllowed;
    /// @notice keccak256(abi.encode(kind, addr)) → timestamp from which `applyAllowlist` may run.
    mapping(bytes32 => uint40) public proposedAt;
    /// @notice Chainlink feed per stock; address(0) = no reference floor for that stock.
    mapping(address => address) public feeds;

    uint256 public planCount;
    mapping(uint256 => Plan) public plans;
    mapping(uint256 => Leg[]) private _legs;
    mapping(address => uint256[]) private _plansOf;

    uint256 private _entered = 1;

    event PlanCreated(uint256 indexed planId, address indexed owner, uint128 amountPerRun, uint32 interval, uint40 nextRunAt, uint40 expiry, uint16 maxSlippageBps);
    /// @notice The legs of a new plan, emitted just before its PlanCreated.
    event PlanLegs(uint256 indexed planId, address[] assets, uint16[] weightsBps);
    event PlanUpdated(uint256 indexed planId, uint128 amountPerRun, uint32 interval, uint40 expiry, uint16 maxSlippageBps);
    event PlanStatus(uint256 indexed planId, uint8 status);
    event PlanExecuted(uint256 indexed planId, uint32 indexed run, uint256 spent, uint40 nextRunAt);
    event LegFilled(uint256 indexed planId, address indexed asset, uint256 spent, uint256 received);
    event LegSkipped(uint256 indexed planId, address indexed asset);
    event AllowlistProposed(Kind indexed kind, address indexed target, uint40 effectiveAt);
    event AllowlistChanged(Kind indexed kind, address indexed target, bool allowed);
    event FeedSet(address indexed asset, address indexed feed);
    event KeeperChanged(address indexed keeper);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error NotKeeper();
    error NotPlanOwner();
    error PlanUnknown();
    error PlanNotActive();
    error PlanIsCancelled();
    error NotDue();
    error PlanExpired();
    error BadLegs();
    error BadWeights();
    error DuplicateAsset();
    error BadAmount();
    error BadInterval();
    error BadExpiry();
    error BadSlippage();
    error BadSwaps();
    error LegTooLarge(uint256 leg);
    error NothingToBuy();
    error RouteNotAllowed();
    error SwapFailed();
    error TooLittleReceived(uint256 leg, uint256 received, uint256 required);
    error TransferFailed();
    error Reentered();
    error NotProposed();
    error DelayNotPassed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert Reentered();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @param usdc     The token every plan spends (USDC on Base).
    /// @param keeper_  Address allowed to trigger due runs on the owners' behalf.
    /// @param routers  Swap targets allowed from day one (announced by the deployment itself).
    /// @param spenders Allowance targets allowed from day one (usually the same routers).
    constructor(address usdc, address keeper_, address[] memory routers, address[] memory spenders) {
        if (usdc == address(0) || keeper_ == address(0)) revert ZeroAddress();
        USDC = IERC20(usdc);
        USDC_UNIT = 10 ** IERC20(usdc).decimals();
        owner = msg.sender;
        keeper = keeper_;
        for (uint256 i = 0; i < routers.length; i++) _setAllowed(Kind.Router, routers[i], true);
        for (uint256 i = 0; i < spenders.length; i++) _setAllowed(Kind.Spender, spenders[i], true);
        emit KeeperChanged(keeper_);
    }

    /* ------------------------------- plans -------------------------------- */

    /**
     * @notice Create a plan. Weights must total 100%; `firstRunAt == 0` means "due now".
     * @dev    The USDC allowance is not checked here so an approve can sit in the same batch; a
     *         missing allowance simply makes the first run revert until it is granted.
     */
    function createPlan(
        address[] calldata assets,
        uint16[] calldata weightsBps,
        uint128 amountPerRun,
        uint32 interval,
        uint40 firstRunAt,
        uint40 expiry,
        uint16 maxSlippageBps
    ) external returns (uint256 planId) {
        _checkTerms(amountPerRun, interval, expiry, maxSlippageBps);
        if (firstRunAt != 0 && expiry != 0 && firstRunAt > expiry) revert BadExpiry();

        planId = ++planCount;
        _storeLegs(planId, assets, weightsBps);
        Plan storage p = plans[planId];
        p.owner = msg.sender;
        p.amountPerRun = amountPerRun;
        p.interval = interval;
        p.nextRunAt = firstRunAt == 0 ? uint40(block.timestamp) : firstRunAt;
        p.expiry = expiry;
        p.maxSlippageBps = maxSlippageBps;
        _plansOf[msg.sender].push(planId);
        emit PlanCreated(planId, msg.sender, amountPerRun, interval, p.nextRunAt, expiry, maxSlippageBps);
    }

    function _storeLegs(uint256 planId, address[] calldata assets, uint16[] calldata weightsBps) private {
        uint256 n = assets.length;
        if (n == 0 || n > MAX_LEGS || weightsBps.length != n) revert BadLegs();
        Leg[] storage legs = _legs[planId];
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            address asset = assets[i];
            if (asset == address(0) || asset == address(USDC)) revert BadLegs();
            if (weightsBps[i] == 0) revert BadWeights();
            for (uint256 j = 0; j < i; j++) {
                if (assets[j] == asset) revert DuplicateAsset();
            }
            sum += weightsBps[i];
            legs.push(Leg({asset: asset, weightBps: weightsBps[i]}));
        }
        if (sum != TOTAL_BPS) revert BadWeights();
        emit PlanLegs(planId, assets, weightsBps);
    }

    /// @notice Change the terms of a plan; the legs (which stocks, what mix) are fixed for its lifetime.
    function updatePlan(uint256 planId, uint128 amountPerRun, uint32 interval, uint40 expiry, uint16 maxSlippageBps) external {
        Plan storage p = _ownedPlan(planId);
        if (p.status == 2) revert PlanIsCancelled();
        _checkTerms(amountPerRun, interval, expiry, maxSlippageBps);
        p.amountPerRun = amountPerRun;
        p.interval = interval;
        p.expiry = expiry;
        p.maxSlippageBps = maxSlippageBps;
        emit PlanUpdated(planId, amountPerRun, interval, expiry, maxSlippageBps);
    }

    /// @notice Pause (false) or resume (true). A run that fell due while paused is owed once on resume.
    function setPlanActive(uint256 planId, bool active) external {
        Plan storage p = _ownedPlan(planId);
        if (p.status == 2) revert PlanIsCancelled();
        p.status = active ? 0 : 1;
        emit PlanStatus(planId, p.status);
    }

    /// @notice Terminal. A cancelled plan can never run again; create a new one instead.
    function cancelPlan(uint256 planId) external {
        Plan storage p = _ownedPlan(planId);
        if (p.status == 2) revert PlanIsCancelled();
        p.status = 2;
        emit PlanStatus(planId, 2);
    }

    /**
     * @notice Run a due plan. One swap per leg, in leg order; `amountIn == 0` skips a leg (a stock
     *         that is not issued or has no pool today) and its share simply stays in the owner's
     *         wallet. Everything is one transaction: if any leg cannot deliver, nothing moves.
     */
    function execute(uint256 planId, Swap[] calldata swaps) external nonReentrant {
        Plan storage p = plans[planId];
        if (p.owner == address(0)) revert PlanUnknown();
        if (msg.sender != keeper && msg.sender != p.owner) revert NotKeeper();
        if (p.status != 0) revert PlanNotActive();
        if (block.timestamp < p.nextRunAt) revert NotDue();
        if (p.expiry != 0 && block.timestamp > p.expiry) revert PlanExpired();

        Leg[] storage legs = _legs[planId];
        uint256 total = _checkCaps(p.amountPerRun, legs, swaps);
        address planOwner = p.owner;
        uint256 usdcBefore = USDC.balanceOf(address(this));
        _pull(planOwner, total);

        for (uint256 i = 0; i < swaps.length; i++) {
            if (swaps[i].amountIn == 0) {
                emit LegSkipped(planId, legs[i].asset);
                continue;
            }
            _fill(planId, i, planOwner, legs[i].asset, swaps[i], p.maxSlippageBps);
        }

        uint256 leftover = USDC.balanceOf(address(this)) - usdcBefore;
        if (leftover > 0) _push(planOwner, leftover);

        p.runs += 1;
        p.lastRunAt = uint40(block.timestamp);
        p.nextRunAt = _advance(p.nextRunAt, p.interval, block.timestamp);
        emit PlanExecuted(planId, p.runs, total - leftover, p.nextRunAt);
    }

    /// @dev One swap per leg, each capped at the leg's share of the run; returns the USDC to pull.
    function _checkCaps(uint128 amountPerRun, Leg[] storage legs, Swap[] calldata swaps) private view returns (uint256 total) {
        uint256 n = legs.length;
        if (swaps.length != n) revert BadSwaps();
        for (uint256 i = 0; i < n; i++) {
            uint256 cap = (uint256(amountPerRun) * legs[i].weightBps) / TOTAL_BPS;
            if (swaps[i].amountIn > cap) revert LegTooLarge(i);
            total += swaps[i].amountIn;
        }
        if (total == 0) revert NothingToBuy();
    }

    /// @dev Approve exactly one leg, call the router, reset the approval, then judge the outcome by
    ///      what the owner actually holds — never by what the router claims to have done.
    function _fill(uint256 planId, uint256 i, address planOwner, address asset, Swap calldata s, uint16 maxSlippageBps) private {
        if (!routerAllowed[s.target] || !spenderAllowed[s.spender]) revert RouteNotAllowed();
        uint256 before = IERC20(asset).balanceOf(planOwner);
        _approve(s.spender, s.amountIn);
        (bool ok, bytes memory ret) = s.target.call(s.data);
        if (!ok) _bubble(ret);
        _approve(s.spender, 0);

        uint256 received = IERC20(asset).balanceOf(planOwner) - before;
        uint256 required = s.minOut;
        uint256 floor = quoteFloor(asset, s.amountIn, maxSlippageBps);
        if (floor > required) required = floor;
        if (received == 0 || received < required) revert TooLittleReceived(i, received, required);
        emit LegFilled(planId, asset, s.amountIn, received);
    }

    /* ------------------------------- views -------------------------------- */

    function legsOf(uint256 planId) external view returns (Leg[] memory) {
        return _legs[planId];
    }

    function plansOf(address account) external view returns (uint256[] memory) {
        return _plansOf[account];
    }

    /// @notice True when `execute` would not revert for timing or status reasons.
    function isDue(uint256 planId) external view returns (bool) {
        Plan storage p = plans[planId];
        if (p.owner == address(0) || p.status != 0) return false;
        if (block.timestamp < p.nextRunAt) return false;
        if (p.expiry != 0 && block.timestamp > p.expiry) return false;
        return true;
    }

    /**
     * @notice Fewest raw stock units a leg spending `amountIn` USDC may deliver, from the registered
     *         Chainlink reference less `maxSlippageBps`; 0 when there is no usable reference (no feed,
     *         a non-positive answer, or an answer older than MAX_FEED_AGE).
     * @dev    The feed prices one share; the B20 multiplier turns shares into raw units
     *         (raw = shares × 1e18 / multiplier), so a split or dividend never mis-sizes the floor.
     */
    function quoteFloor(address asset, uint256 amountIn, uint16 maxSlippageBps) public view returns (uint256) {
        address feed = feeds[asset];
        if (feed == address(0)) return 0;
        int256 answer;
        uint256 updatedAt;
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 a, uint256, uint256 u, uint80) {
            answer = a;
            updatedAt = u;
        } catch {
            return 0;
        }
        if (answer <= 0 || updatedAt + MAX_FEED_AGE < block.timestamp) return 0;
        uint256 multiplier = WAD;
        try IB20Multiplier(asset).multiplier() returns (uint256 m) {
            if (m > 0) multiplier = m;
        } catch {}
        uint256 expected = (amountIn * (10 ** IAggregatorV3(feed).decimals()) * (10 ** IERC20(asset).decimals()) * WAD) / (USDC_UNIT * uint256(answer) * multiplier);
        return (expected * (TOTAL_BPS - maxSlippageBps)) / TOTAL_BPS;
    }

    /// @notice The schedule anchor after a run at `now`: strictly in the future, on the plan's own grid.
    function nextAnchor(uint40 anchor, uint32 interval, uint256 nowTs) external pure returns (uint40) {
        return _advance(anchor, interval, nowTs);
    }

    /* ------------------------------ operator ------------------------------ */

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperChanged(keeper_);
    }

    /// @notice Announce a new router or spender; it becomes usable after ALLOWLIST_DELAY.
    function proposeAllowlist(Kind kind, address target) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        uint40 at = uint40(block.timestamp + ALLOWLIST_DELAY);
        proposedAt[_key(kind, target)] = at;
        emit AllowlistProposed(kind, target, at);
    }

    function applyAllowlist(Kind kind, address target) external onlyOwner {
        bytes32 k = _key(kind, target);
        uint40 at = proposedAt[k];
        if (at == 0) revert NotProposed();
        if (block.timestamp < at) revert DelayNotPassed();
        delete proposedAt[k];
        _setAllowed(kind, target, true);
    }

    /// @notice Removal is immediate: taking a route away can only ever stop runs, never redirect them.
    function revokeAllowlist(Kind kind, address target) external onlyOwner {
        delete proposedAt[_key(kind, target)];
        _setAllowed(kind, target, false);
    }

    /// @notice A feed only ever raises the bar a swap must clear; address(0) removes the floor.
    function setFeed(address asset, address feed) external onlyOwner {
        feeds[asset] = feed;
        emit FeedSet(asset, feed);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(msg.sender);
    }

    /* ------------------------------ internals ----------------------------- */

    function _ownedPlan(uint256 planId) private view returns (Plan storage p) {
        p = plans[planId];
        if (p.owner == address(0)) revert PlanUnknown();
        if (p.owner != msg.sender) revert NotPlanOwner();
    }

    function _checkTerms(uint128 amountPerRun, uint32 interval, uint40 expiry, uint16 maxSlippageBps) private view {
        if (amountPerRun < USDC_UNIT) revert BadAmount();
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert BadInterval();
        if (expiry != 0 && (expiry <= block.timestamp || expiry > block.timestamp + MAX_PLAN_DURATION)) revert BadExpiry();
        if (maxSlippageBps < MIN_SLIPPAGE_BPS || maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadSlippage();
    }

    /// @dev O(1) catch-up: the next anchor is the first grid point after `nowTs`, never a stacked backlog.
    function _advance(uint40 anchor, uint32 interval, uint256 nowTs) private pure returns (uint40) {
        uint256 next = uint256(anchor) + interval;
        if (next <= nowTs) {
            uint256 missed = (nowTs - anchor) / interval;
            next = uint256(anchor) + (missed + 1) * interval;
        }
        return uint40(next);
    }

    function _key(Kind kind, address target) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, target));
    }

    function _setAllowed(Kind kind, address target, bool allowed) private {
        if (target == address(0)) revert ZeroAddress();
        if (kind == Kind.Router) routerAllowed[target] = allowed;
        else spenderAllowed[target] = allowed;
        emit AllowlistChanged(kind, target, allowed);
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = address(USDC).call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(USDC).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = address(USDC).call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _bubble(bytes memory ret) private pure {
        if (ret.length == 0) revert SwapFailed();
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}
