// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GiftPool} from "../src/GiftPool.sol";

/// @dev Foundry cheatcodes used directly (no forge-std dependency).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function assume(bool) external pure;
}

/* ============================== mock tokens ============================== */

/// @dev ERC-20 with B20-like failure modes: issuer pause and per-address policy blocks.
contract MockB20 {
    string public symbol;
    uint8 public constant decimals = 8;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;
    mapping(address => bool) public blockedReceiver;

    constructor(string memory s) {
        symbol = s;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlockedReceiver(address who, bool blocked) external {
        blockedReceiver[who] = blocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(!paused, "B20: paused");
        require(!blockedReceiver[to], "B20: policy forbids");
        require(balanceOf[from] >= amount, "B20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "B20: allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}

/// @dev Token that lies: returns false instead of reverting.
contract FalseToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Token that keeps 1% on the way in — the pool must refuse to hold it.
contract FeeToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Token that quietly hands out MORE than it was sent — also refused, the surplus would
///      make the pool's per-claim accounting a lie in the other direction.
contract InflatingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount + 1;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Token that reenters the pool while it is paying out.
contract ReentrantToken {
    enum Mode {
        None,
        Claim,
        Withdraw
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    GiftPool public pool;
    bytes32 public targetId;
    Mode public mode;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(GiftPool p, bytes32 id, Mode m) external {
        pool = p;
        targetId = id;
        mode = m;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == Mode.Claim) {
            pool.claim(targetId, address(this), type(uint64).max, 27, bytes32(0), bytes32(0));
        } else if (mode == Mode.Withdraw) {
            pool.withdrawLeg(targetId, 0);
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Token that reenters the pool while the pool is pulling its deposit in. Slither flags the
///      balance-delta check in `create` as reentrancy-prone because it cannot see through the
///      custom guard; these prove what the guard actually does.
contract DepositReentrantToken {
    enum Mode {
        None,
        Create,
        Cancel,
        Withdraw,
        Claim
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    GiftPool public pool;
    bytes32 public targetId;
    Mode public mode;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(GiftPool p, bytes32 id, Mode m) external {
        pool = p;
        targetId = id;
        mode = m;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == Mode.Create) {
            address[] memory t = new address[](1);
            t[0] = address(this);
            uint256[] memory a = new uint256[](1);
            a[0] = 1;
            pool.create("reenter", address(0), 1, uint64(block.timestamp + 1 days), 0, t, a, bytes32(0));
        } else if (mode == Mode.Cancel) {
            pool.cancel(targetId);
        } else if (mode == Mode.Withdraw) {
            pool.withdraw(targetId);
        } else if (mode == Mode.Claim) {
            pool.claim(targetId, address(this), type(uint64).max, 27, bytes32(0), bytes32(0));
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/* ================================= tests ================================ */

contract GiftPoolTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SECP_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    GiftPool internal pool;
    MockB20 internal nvda;
    MockB20 internal aapl;

    uint256 internal constant GATE_PK = 0x6A7E;
    uint256 internal constant OTHER_PK = 0xBADBAD;
    address internal gate;

    address internal constant CREATOR = address(0xC4EA704);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    address internal constant RELAYER = address(0x8E1A7E4);
    address internal constant STRANGER = address(0xD15EA5E);

    uint32 internal constant SLOTS = 10;
    uint256 internal constant PER = 1e7; // 0.1 token at 8 decimals
    uint256 internal constant TOTAL = PER * SLOTS;
    uint64 internal expiry;
    uint64 internal deadline;

    function setUp() public {
        pool = new GiftPool();
        nvda = new MockB20("NVDAc");
        aapl = new MockB20("AAPLc");
        gate = vm.addr(GATE_PK);
        expiry = uint64(block.timestamp + 7 days);
        deadline = uint64(block.timestamp + 1 days);
        nvda.mint(CREATOR, 1000e8);
        aapl.mint(CREATOR, 1000e8);
        vm.startPrank(CREATOR);
        nvda.approve(address(pool), type(uint256).max);
        aapl.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /* ------------------------------ helpers ------------------------------ */

    function _one(address t) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = t;
    }

    function _one(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function _two(address t0, address t1) internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = t0;
        a[1] = t1;
    }

    function _two(uint256 x0, uint256 x1) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x0;
        a[1] = x1;
    }

    /// Open pool: anyone may take one share, self-claim only.
    function _openPool(bytes32 salt) internal returns (bytes32 id) {
        vm.prank(CREATOR);
        id = pool.create(salt, address(0), SLOTS, expiry, 0, _one(address(nvda)), _one(PER), keccak256("memo"));
    }

    /// Gated pool: every claim carries a ticket signed by `gate`.
    function _gatedPool(bytes32 salt) internal returns (bytes32 id) {
        vm.prank(CREATOR);
        id = pool.create(salt, gate, SLOTS, expiry, 0, _one(address(nvda)), _one(PER), keccak256("memo"));
    }

    function _ticket(bytes32 id, address recipient, uint64 dl, uint256 pk)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return vm.sign(pk, pool.ticketDigest(id, recipient, dl));
    }

    function _selfClaim(bytes32 id, address who) internal {
        vm.prank(who);
        pool.claim(id, who, 0, 0, bytes32(0), bytes32(0));
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    /* ------------------------------- create ------------------------------ */

    function test_create_locks_tokens_and_stores_pool() public {
        bytes32 id = _openPool("s1");
        _eq(nvda.balanceOf(address(pool)), TOTAL, "pool holds total");
        _eq(nvda.balanceOf(CREATOR), 1000e8 - TOTAL, "creator debited");
        (address creator, address g, uint32 slots, uint32 claimed, uint64 exp, uint64 lock, bool cancelled) =
            pool.pools(id);
        require(creator == CREATOR && g == address(0), "creator + gate");
        require(slots == SLOTS && claimed == 0 && exp == expiry && lock == 0 && !cancelled, "fields");
        require(id == pool.poolId(CREATOR, "s1"), "id derivation");
        _eq(pool.remainingSlots(id), SLOTS, "all slots open");
        _eq(pool.legCount(id), 1, "one leg");
    }

    function test_create_multi_leg_pulls_every_token() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create(
            "pkg", address(0), 4, expiry, 0, _two(address(nvda), address(aapl)), _two(PER, 2 * PER), bytes32(0)
        );
        _eq(nvda.balanceOf(address(pool)), PER * 4, "leg 0 funded");
        _eq(aapl.balanceOf(address(pool)), 2 * PER * 4, "leg 1 funded");
        GiftPool.Leg[] memory legs = pool.legsOf(id);
        require(legs.length == 2 && legs[0].token == address(nvda) && legs[1].token == address(aapl), "legs stored");
        require(legs[1].amountPerClaim == 2 * PER && !legs[1].withdrawn, "leg fields");
    }

    function test_create_rejects_zero_slots() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.AmountZero.selector);
        pool.create("s", address(0), 0, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
    }

    function test_create_rejects_zero_amount() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.AmountZero.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, _one(address(nvda)), _one(0), bytes32(0));
    }

    function test_create_rejects_empty_and_mismatched_legs() public {
        vm.startPrank(CREATOR);
        vm.expectRevert(GiftPool.BadLegs.selector);
        pool.create("a", address(0), SLOTS, expiry, 0, new address[](0), new uint256[](0), bytes32(0));
        vm.expectRevert(GiftPool.BadLegs.selector);
        pool.create("b", address(0), SLOTS, expiry, 0, _two(address(nvda), address(aapl)), _one(PER), bytes32(0));
        vm.stopPrank();
    }

    function test_create_rejects_too_many_legs() public {
        address[] memory tokens = new address[](9);
        uint256[] memory amounts = new uint256[](9);
        for (uint256 i = 0; i < 9; ++i) {
            tokens[i] = address(new MockB20("X"));
            amounts[i] = PER;
        }
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.BadLegs.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, tokens, amounts, bytes32(0));
    }

    function test_create_rejects_duplicate_token() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.DuplicateToken.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, _two(address(nvda), address(nvda)), _two(PER, PER), bytes32(0));
    }

    function test_create_rejects_past_and_far_expiry() public {
        vm.startPrank(CREATOR);
        vm.expectRevert(GiftPool.BadExpiry.selector);
        pool.create("a", address(0), SLOTS, uint64(block.timestamp), 0, _one(address(nvda)), _one(PER), bytes32(0));
        vm.expectRevert(GiftPool.BadExpiry.selector);
        pool.create(
            "b", address(0), SLOTS, uint64(block.timestamp + 366 days), 0, _one(address(nvda)), _one(PER), bytes32(0)
        );
        vm.stopPrank();
    }

    function test_create_rejects_lock_beyond_expiry() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.BadExpiry.selector);
        pool.create("s", address(0), SLOTS, expiry, expiry + 1, _one(address(nvda)), _one(PER), bytes32(0));
    }

    function test_create_rejects_reused_salt() public {
        _openPool("s1");
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.PoolExists.selector);
        pool.create("s1", address(0), SLOTS, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
    }

    function test_create_same_salt_different_creators_is_fine() public {
        _openPool("s1");
        nvda.mint(STRANGER, TOTAL);
        vm.startPrank(STRANGER);
        nvda.approve(address(pool), TOTAL);
        bytes32 other = pool.create("s1", address(0), SLOTS, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
        vm.stopPrank();
        require(other != pool.poolId(CREATOR, "s1"), "ids namespaced by creator");
    }

    function test_create_rejects_false_returning_token() public {
        FalseToken bad = new FalseToken();
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.TransferFailed.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, _one(address(bad)), _one(PER), bytes32(0));
    }

    function test_create_rejects_fee_on_transfer_token() public {
        FeeToken fee = new FeeToken();
        fee.mint(CREATOR, 1000e8);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.UnsupportedToken.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, _one(address(fee)), _one(PER), bytes32(0));
    }

    function test_create_rejects_inflating_token() public {
        InflatingToken inflate = new InflatingToken();
        inflate.mint(CREATOR, 1000e8);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.UnsupportedToken.selector);
        pool.create("s", address(0), SLOTS, expiry, 0, _one(address(inflate)), _one(PER), bytes32(0));
    }

    function test_create_reverts_when_total_overflows() public {
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        pool.create("s", address(0), 2, expiry, 0, _one(address(nvda)), _one(type(uint256).max), bytes32(0));
    }

    /* --------------------------- claim: open pool ------------------------ */

    function test_open_claim_pays_the_caller() public {
        bytes32 id = _openPool("s1");
        _selfClaim(id, ALICE);
        _eq(nvda.balanceOf(ALICE), PER, "alice paid one share");
        _eq(nvda.balanceOf(address(pool)), TOTAL - PER, "pool debited one share");
        _eq(pool.remainingSlots(id), SLOTS - 1, "one slot gone");
        require(pool.hasClaimed(id, ALICE), "marked claimed");
    }

    function test_open_claim_refuses_claiming_for_someone_else() public {
        bytes32 id = _openPool("s1");
        vm.prank(STRANGER);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_open_claim_ignores_any_signature_material() public {
        bytes32 id = _openPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, OTHER_PK);
        vm.prank(ALICE);
        pool.claim(id, ALICE, deadline, v, r, s); // garbage ticket, self-claim still valid
        _eq(nvda.balanceOf(ALICE), PER, "paid");
    }

    function test_claim_rejects_zero_recipient() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, address(0), deadline, GATE_PK);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, address(0), deadline, v, r, s);
    }

    function test_claim_once_per_address() public {
        bytes32 id = _openPool("s1");
        _selfClaim(id, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.AlreadyClaimed.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_claim_stops_when_slots_run_out() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create("small", address(0), 2, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
        _selfClaim(id, ALICE);
        _selfClaim(id, BOB);
        _eq(pool.remainingSlots(id), 0, "exhausted");
        vm.prank(CAROL);
        vm.expectRevert(GiftPool.PoolEmpty.selector);
        pool.claim(id, CAROL, 0, 0, bytes32(0), bytes32(0));
        _eq(nvda.balanceOf(address(pool)), 0, "pool drained exactly");
    }

    function test_claim_rejects_after_expiry() public {
        bytes32 id = _openPool("s1");
        vm.warp(uint256(expiry) + 1);
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.PoolClosed.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_claim_rejects_after_cancel() public {
        bytes32 id = _openPool("s1");
        vm.prank(CREATOR);
        pool.cancel(id);
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.PoolClosed.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_claim_unknown_pool() public {
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.PoolUnknown.selector);
        pool.claim(keccak256("nope"), ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    /* -------------------------- claim: gated pool ------------------------ */

    function test_gated_claim_may_be_submitted_by_a_relayer() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, GATE_PK);
        vm.prank(RELAYER); // sponsored gas: the submitter is not the recipient
        pool.claim(id, ALICE, deadline, v, r, s);
        _eq(nvda.balanceOf(ALICE), PER, "alice paid");
        _eq(nvda.balanceOf(RELAYER), 0, "relayer gets nothing");
    }

    function test_gated_claim_rejects_wrong_signer() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, OTHER_PK);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, ALICE, deadline, v, r, s);
    }

    function test_gated_ticket_binds_the_recipient() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, GATE_PK);
        vm.prank(BOB);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, BOB, deadline, v, r, s);
    }

    function test_gated_ticket_binds_the_pool() public {
        bytes32 idA = _gatedPool("a");
        bytes32 idB = _gatedPool("b");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(idA, ALICE, deadline, GATE_PK);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(idB, ALICE, deadline, v, r, s);
    }

    function test_gated_ticket_expires() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, GATE_PK);
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(GiftPool.TicketExpired.selector);
        pool.claim(id, ALICE, deadline, v, r, s);
    }

    function test_gated_rejects_malleable_signature() public {
        bytes32 id = _gatedPool("s1");
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, GATE_PK);
        // The twin signature (n - s, flipped v) recovers the same signer on a naive check.
        bytes32 flipped = bytes32(SECP_ORDER - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, ALICE, deadline, flippedV, r, flipped);
    }

    function test_gated_rejects_out_of_range_v() public {
        bytes32 id = _gatedPool("s1");
        (, bytes32 r, bytes32 s) = _ticket(id, ALICE, deadline, GATE_PK);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, ALICE, deadline, 29, r, s);
    }

    function test_gated_rejects_empty_signature() public {
        bytes32 id = _gatedPool("s1");
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, ALICE, deadline, 27, bytes32(0), bytes32(0));
    }

    /* ------------------------------ multi-leg ---------------------------- */

    function test_multi_leg_claim_pays_every_leg() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create(
            "pkg", address(0), 4, expiry, 0, _two(address(nvda), address(aapl)), _two(PER, 2 * PER), bytes32(0)
        );
        _selfClaim(id, ALICE);
        _eq(nvda.balanceOf(ALICE), PER, "nvda share");
        _eq(aapl.balanceOf(ALICE), 2 * PER, "aapl share");
    }

    function test_paused_leg_blocks_the_whole_claim_then_retry_works() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create(
            "pkg", address(0), 4, expiry, 0, _two(address(nvda), address(aapl)), _two(PER, PER), bytes32(0)
        );
        aapl.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(bytes("B20: paused"));
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
        // Nothing moved and no slot was burned.
        _eq(nvda.balanceOf(ALICE), 0, "no partial payout");
        _eq(pool.remainingSlots(id), 4, "slot intact");
        require(!pool.hasClaimed(id, ALICE), "not marked");

        aapl.setPaused(false);
        _selfClaim(id, ALICE);
        _eq(aapl.balanceOf(ALICE), PER, "paid after unpause");
    }

    function test_receiver_policy_block_reverts_the_claim() public {
        bytes32 id = _openPool("s1");
        nvda.setBlockedReceiver(ALICE, true);
        vm.prank(ALICE);
        vm.expectRevert(bytes("B20: policy forbids"));
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    /* ------------------------------- cancel ------------------------------ */

    function test_cancel_by_creator_closes_the_pool() public {
        bytes32 id = _openPool("s1");
        vm.prank(CREATOR);
        pool.cancel(id);
        (,,,,,, bool cancelled) = pool.pools(id);
        require(cancelled, "flag set");
        _eq(pool.remainingSlots(id), 0, "no slots left");
        _eq(nvda.balanceOf(address(pool)), TOTAL, "cancel moves nothing");
    }

    function test_cancel_rejects_stranger() public {
        bytes32 id = _openPool("s1");
        vm.prank(STRANGER);
        vm.expectRevert(GiftPool.NotCreator.selector);
        pool.cancel(id);
    }

    function test_cancel_rejects_unknown_pool() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.PoolUnknown.selector);
        pool.cancel(keccak256("nope"));
    }

    function test_cancel_twice_rejected() public {
        bytes32 id = _openPool("s1");
        vm.startPrank(CREATOR);
        pool.cancel(id);
        vm.expectRevert(GiftPool.PoolClosed.selector);
        pool.cancel(id);
        vm.stopPrank();
    }

    function test_cancel_waits_for_the_lock_then_succeeds() public {
        uint64 lock = uint64(block.timestamp + 3 days);
        vm.prank(CREATOR);
        bytes32 id = pool.create("lock", address(0), SLOTS, expiry, lock, _one(address(nvda)), _one(PER), bytes32(0));
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.StillLocked.selector);
        pool.cancel(id);
        // Claims keep working while the creator's hands are tied.
        _selfClaim(id, ALICE);
        vm.warp(uint256(lock));
        vm.prank(CREATOR);
        pool.cancel(id);
        (,,,,,, bool cancelled) = pool.pools(id);
        require(cancelled, "cancelled after lock");
    }

    /* ------------------------------ withdraw ----------------------------- */

    function test_withdraw_returns_the_unclaimed_remainder() public {
        bytes32 id = _openPool("s1");
        _selfClaim(id, ALICE);
        _selfClaim(id, BOB);
        vm.startPrank(CREATOR);
        pool.cancel(id);
        pool.withdraw(id);
        vm.stopPrank();
        _eq(nvda.balanceOf(address(pool)), 0, "pool empty");
        _eq(nvda.balanceOf(CREATOR), 1000e8 - 2 * PER, "creator got the rest back");
        _eq(nvda.balanceOf(ALICE) + nvda.balanceOf(BOB), 2 * PER, "claimants keep theirs");
    }

    function test_withdraw_rejected_while_the_pool_is_live() public {
        bytes32 id = _openPool("s1");
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.StillOpen.selector);
        pool.withdraw(id);
    }

    function test_withdraw_after_expiry_without_cancel() public {
        bytes32 id = _openPool("s1");
        _selfClaim(id, ALICE);
        vm.warp(uint256(expiry) + 1);
        vm.prank(CREATOR);
        pool.withdraw(id);
        _eq(nvda.balanceOf(CREATOR), 1000e8 - PER, "refunded after expiry");
    }

    function test_withdraw_rejects_stranger() public {
        bytes32 id = _openPool("s1");
        vm.prank(CREATOR);
        pool.cancel(id);
        vm.prank(STRANGER);
        vm.expectRevert(GiftPool.NotCreator.selector);
        pool.withdraw(id);
    }

    function test_withdraw_rejects_unknown_pool() public {
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.PoolUnknown.selector);
        pool.withdraw(keccak256("nope"));
    }

    function test_withdraw_leg_twice_rejected() public {
        bytes32 id = _openPool("s1");
        vm.startPrank(CREATOR);
        pool.cancel(id);
        pool.withdrawLeg(id, 0);
        vm.expectRevert(GiftPool.AlreadyWithdrawn.selector);
        pool.withdrawLeg(id, 0);
        vm.stopPrank();
    }

    function test_withdraw_is_idempotent_after_all_legs_are_out() public {
        bytes32 id = _openPool("s1");
        vm.startPrank(CREATOR);
        pool.cancel(id);
        pool.withdraw(id);
        pool.withdraw(id); // no-op, does not revert
        vm.stopPrank();
        _eq(nvda.balanceOf(CREATOR), 1000e8, "refunded exactly once");
    }

    function test_withdraw_out_of_range_leg_panics() public {
        bytes32 id = _openPool("s1");
        vm.startPrank(CREATOR);
        pool.cancel(id);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x32));
        pool.withdrawLeg(id, 1);
        vm.stopPrank();
    }

    /// A paused stock must not trap the healthy legs of the same package.
    function test_one_paused_leg_does_not_trap_the_others() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create(
            "pkg", address(0), 4, expiry, 0, _two(address(nvda), address(aapl)), _two(PER, PER), bytes32(0)
        );
        aapl.setPaused(true);
        vm.startPrank(CREATOR);
        pool.cancel(id); // always succeeds: no transfer here
        vm.expectRevert(bytes("B20: paused"));
        pool.withdraw(id); // the batch trips on the paused leg
        pool.withdrawLeg(id, 0); // the healthy leg still comes home
        vm.stopPrank();
        _eq(nvda.balanceOf(CREATOR), 1000e8, "nvda recovered");
        _eq(aapl.balanceOf(address(pool)), PER * 4, "aapl waits for the issuer");

        aapl.setPaused(false);
        vm.prank(CREATOR);
        pool.withdrawLeg(id, 1);
        _eq(aapl.balanceOf(CREATOR), 1000e8, "aapl recovered later");
    }

    function test_withdraw_after_full_claim_moves_nothing() public {
        vm.prank(CREATOR);
        bytes32 id = pool.create("small", address(0), 2, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
        _selfClaim(id, ALICE);
        _selfClaim(id, BOB);
        vm.startPrank(CREATOR);
        pool.cancel(id);
        pool.withdraw(id);
        vm.stopPrank();
        _eq(nvda.balanceOf(CREATOR), 1000e8 - 2 * PER, "nothing extra returned");
    }

    /* ------------------------------- views ------------------------------- */

    function test_remainingSlots_across_states() public {
        _eq(pool.remainingSlots(keccak256("nope")), 0, "unknown pool");
        bytes32 id = _openPool("s1");
        _eq(pool.remainingSlots(id), SLOTS, "fresh");
        _selfClaim(id, ALICE);
        _eq(pool.remainingSlots(id), SLOTS - 1, "after a claim");
        vm.warp(uint256(expiry) + 1);
        _eq(pool.remainingSlots(id), 0, "expired");
    }

    /* ----------------------------- reentrancy ---------------------------- */

    function test_claim_blocks_reentrancy() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(CREATOR, TOTAL);
        vm.startPrank(CREATOR);
        evil.approve(address(pool), type(uint256).max);
        bytes32 id = pool.create("evil", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));
        vm.stopPrank();
        evil.arm(pool, id, ReentrantToken.Mode.Claim);
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
    }

    function test_withdraw_blocks_reentrancy() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(CREATOR, TOTAL);
        vm.startPrank(CREATOR);
        evil.approve(address(pool), type(uint256).max);
        bytes32 id = pool.create("evil", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));
        pool.cancel(id);
        vm.stopPrank();
        evil.arm(pool, id, ReentrantToken.Mode.Withdraw);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.withdraw(id);
    }

    /* ------------------- reentrancy during the deposit pull ------------------ */

    /// Sets up a pool whose only leg is a token that reenters while `create` pulls the deposit.
    function _armDeposit(DepositReentrantToken evil, DepositReentrantToken.Mode m, bytes32 salt) internal returns (bytes32 id) {
        id = pool.poolId(CREATOR, salt);
        evil.mint(CREATOR, TOTAL);
        vm.prank(CREATOR);
        evil.approve(address(pool), type(uint256).max);
        evil.arm(pool, id, m);
    }

    function test_create_blocks_reentering_create() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        _armDeposit(evil, DepositReentrantToken.Mode.Create, "d1");
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.create("d1", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));
    }

    /// The pool row exists by the time the deposit is pulled, so a token could try to close it
    /// mid-creation. It is not the creator, and the contract only ever listens to the creator.
    function test_create_blocks_reentering_cancel() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        bytes32 id = _armDeposit(evil, DepositReentrantToken.Mode.Cancel, "d2");
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.NotCreator.selector);
        pool.create("d2", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));
        (address creator,,,,,,) = pool.pools(id);
        require(creator == address(0), "nothing was stored");
    }

    /**
     * `withdraw` used to be the one entry point without the guard (it called the guarded
     * `withdrawLeg`, and two guards on one stack would deadlock), so a token reentering `create`
     * could reach it; that was harmless only because the leg array was still empty at that point.
     * Both withdrawals now share an unguarded `_withdrawLeg` and carry the guard themselves, so
     * the same reentry is refused outright, before there is any leg array to walk.
     */
    function test_create_blocks_reentering_withdraw() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        bytes32 id = _armDeposit(evil, DepositReentrantToken.Mode.Withdraw, "d3");
        uint256 creatorBefore = evil.balanceOf(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.create("d3", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));

        // The whole create unwound: nothing stored, nothing moved.
        _eq(evil.balanceOf(CREATOR), creatorBefore, "creator keeps the deposit");
        _eq(evil.balanceOf(address(pool)), 0, "pool holds nothing");
        (address creator,,,,,,) = pool.pools(id);
        require(creator == address(0), "nothing was stored");
        _eq(pool.legCount(id), 0, "no leg registered");
    }

    /// Same with a healthy leg already funded: the reentering second leg trips `withdraw`'s own
    /// lock and the whole create unwinds, first leg included.
    function test_create_blocks_reentering_withdraw_once_a_leg_exists() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        _armDeposit(evil, DepositReentrantToken.Mode.Withdraw, "d3b");
        uint256 nvdaBefore = nvda.balanceOf(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.create("d3b", address(0), SLOTS, expiry, 0, _two(address(nvda), address(evil)), _two(PER, PER), bytes32(0));
        _eq(nvda.balanceOf(CREATOR), nvdaBefore, "first leg refunded with the revert");
    }

    function test_create_blocks_reentering_claim() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        _armDeposit(evil, DepositReentrantToken.Mode.Claim, "d4");
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.create("d4", address(0), SLOTS, expiry, 0, _one(address(evil)), _one(PER), bytes32(0));
    }

    /// A leg that reenters cannot leave a half-funded pool behind: the whole create reverts, so a
    /// healthy first leg is returned with it.
    function test_reentrant_second_leg_leaves_nothing_behind() public {
        DepositReentrantToken evil = new DepositReentrantToken();
        _armDeposit(evil, DepositReentrantToken.Mode.Create, "d5");
        uint256 nvdaBefore = nvda.balanceOf(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(GiftPool.Reentered.selector);
        pool.create("d5", address(0), SLOTS, expiry, 0, _two(address(nvda), address(evil)), _two(PER, PER), bytes32(0));
        _eq(nvda.balanceOf(CREATOR), nvdaBefore, "first leg refunded with the revert");
        _eq(nvda.balanceOf(address(pool)), 0, "pool holds nothing");
    }

    /* -------------------------------- fuzz ------------------------------- */

    /// Whatever the shape of the pool, a full drain pays every claimant exactly one share and
    /// leaves the contract empty.
    function testFuzz_open_pool_conservation(uint8 rawSlots, uint64 rawPer, uint8 takers) public {
        uint32 slots = uint32(bound(rawSlots, 1, 40));
        uint256 per = bound(rawPer, 1, 1e12);
        uint256 n = bound(takers, 0, slots);
        uint256 total = per * slots;
        nvda.mint(CREATOR, total);
        uint256 creatorBefore = nvda.balanceOf(CREATOR);

        vm.prank(CREATOR);
        bytes32 id = pool.create("fz", address(0), slots, expiry, 0, _one(address(nvda)), _one(per), bytes32(0));
        _eq(nvda.balanceOf(address(pool)), total, "funded");

        for (uint256 i = 0; i < n; ++i) {
            address who = address(uint160(0x10000 + i));
            _selfClaim(id, who);
            _eq(nvda.balanceOf(who), per, "one share each");
        }
        _eq(nvda.balanceOf(address(pool)), total - per * n, "pool holds the rest");
        _eq(pool.remainingSlots(id), slots - uint32(n), "slot count tracks");

        vm.startPrank(CREATOR);
        pool.cancel(id);
        pool.withdraw(id);
        vm.stopPrank();
        _eq(nvda.balanceOf(address(pool)), 0, "nothing stranded");
        _eq(nvda.balanceOf(CREATOR), creatorBefore - per * n, "creator net = what was given away");
    }

    /// A ticket for one address can never pay another, whatever the key.
    function testFuzz_ticket_binds_recipient(uint256 pk, address intended, address thief) public {
        pk = 1 + (pk % (SECP_ORDER - 1));
        vm.assume(intended != thief && intended != address(0) && thief != address(0));
        vm.assume(intended != address(pool) && intended != address(nvda) && intended != CREATOR);
        vm.prank(CREATOR);
        bytes32 id =
            pool.create("fz", vm.addr(pk), SLOTS, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, intended, deadline, pk);
        vm.expectRevert(GiftPool.BadSignature.selector);
        pool.claim(id, thief, deadline, v, r, s);
        // The intended recipient still gets paid.
        pool.claim(id, intended, deadline, v, r, s);
        _eq(nvda.balanceOf(intended), PER, "intended paid");
    }

    /// No address can take two shares of the same pool, however the claim is routed.
    function testFuzz_no_double_claim(uint256 pk, address who) public {
        pk = 1 + (pk % (SECP_ORDER - 1));
        vm.assume(who != address(0) && who != address(pool) && who != address(nvda) && who != CREATOR);
        vm.prank(CREATOR);
        bytes32 id =
            pool.create("fz", vm.addr(pk), SLOTS, expiry, 0, _one(address(nvda)), _one(PER), bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = _ticket(id, who, deadline, pk);
        pool.claim(id, who, deadline, v, r, s);
        vm.expectRevert(GiftPool.AlreadyClaimed.selector);
        pool.claim(id, who, deadline, v, r, s);
        // A freshly signed ticket for the same address is refused too.
        (uint8 v2, bytes32 r2, bytes32 s2) = _ticket(id, who, uint64(block.timestamp + 2 days), pk);
        vm.expectRevert(GiftPool.AlreadyClaimed.selector);
        pool.claim(id, who, uint64(block.timestamp + 2 days), v2, r2, s2);
        _eq(nvda.balanceOf(who), PER, "exactly one share");
    }

    /// Past the expiry nothing claims and the creator always recovers the remainder.
    function testFuzz_expiry_boundary(uint32 wait) public {
        bytes32 id = _openPool("s1");
        vm.warp(uint256(expiry) + 1 + (uint256(wait) % 365 days));
        vm.prank(ALICE);
        vm.expectRevert(GiftPool.PoolClosed.selector);
        pool.claim(id, ALICE, 0, 0, bytes32(0), bytes32(0));
        vm.prank(CREATOR);
        pool.withdraw(id);
        _eq(nvda.balanceOf(CREATOR), 1000e8, "refunded in full");
    }

    /// Two pools by the same creator never share state or funds.
    function testFuzz_pools_are_isolated(bytes32 saltA, bytes32 saltB, uint64 perA, uint64 perB) public {
        vm.assume(saltA != saltB);
        uint256 a = bound(perA, 1, 1e12);
        uint256 b = bound(perB, 1, 1e12);
        nvda.mint(CREATOR, (a + b) * 4);
        vm.startPrank(CREATOR);
        bytes32 idA = pool.create(saltA, address(0), 4, expiry, 0, _one(address(nvda)), _one(a), bytes32(0));
        bytes32 idB = pool.create(saltB, address(0), 4, expiry, 0, _one(address(nvda)), _one(b), bytes32(0));
        vm.stopPrank();
        require(idA != idB, "distinct ids");
        _selfClaim(idA, ALICE);
        require(!pool.hasClaimed(idB, ALICE), "claim does not leak across pools");
        _eq(pool.remainingSlots(idB), 4, "B untouched");
        _selfClaim(idB, ALICE);
        _eq(nvda.balanceOf(ALICE), a + b, "one share of each");
    }

    /// Solvency: at every point the pool holds at least what it still owes.
    function testFuzz_pool_stays_solvent(uint8 rawSlots, uint64 rawPer, uint8 takers) public {
        uint32 slots = uint32(bound(rawSlots, 1, 30));
        uint256 per = bound(rawPer, 1, 1e12);
        nvda.mint(CREATOR, per * slots);
        vm.prank(CREATOR);
        bytes32 id = pool.create("fz", address(0), slots, expiry, 0, _one(address(nvda)), _one(per), bytes32(0));
        uint256 n = bound(takers, 0, slots);
        for (uint256 i = 0; i < n; ++i) {
            _selfClaim(id, address(uint160(0x20000 + i)));
            (,,, uint32 claimed,,,) = pool.pools(id);
            require(nvda.balanceOf(address(pool)) >= per * (slots - claimed), "solvent after each claim");
        }
    }

    /// @dev Local `bound` (no forge-std): maps a fuzz word into [min, max] inclusive.
    function bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        require(min <= max, "bound range");
        uint256 span = max - min + 1;
        return min + (x % span);
    }
}

/* ============================== invariants ============================== */

/// @dev Drives a live pool with valid, randomly ordered operations. Every action is wrapped so a
///      legitimate revert (slot taken, pool closed) does not end the run — only a broken
///      invariant does.
contract PoolHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    GiftPool public immutable pool;
    MockB20 public immutable token;
    bytes32 public immutable id;
    uint256 public immutable perClaim;
    uint32 public immutable slots;
    uint256 public immutable deposited;
    uint256 internal immutable gatePk;

    uint256 public paidOut;
    uint256 public refunded;
    uint256 public claimCount;

    constructor(GiftPool p, MockB20 t, uint256 pk, uint32 s, uint256 per, uint64 expiry) {
        pool = p;
        token = t;
        gatePk = pk;
        slots = s;
        perClaim = per;
        deposited = per * s;
        t.mint(address(this), deposited);
        t.approve(address(p), deposited);
        address[] memory tokens = new address[](1);
        tokens[0] = address(t);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = per;
        id = p.create("inv", vm.addr(pk), s, expiry, 0, tokens, amounts, bytes32(0));
    }

    /// A fresh claimant every time, derived from the fuzz word.
    function doClaim(uint256 seed) external {
        address who = address(uint160(uint256(keccak256(abi.encode("claimant", seed)))));
        if (who == address(0) || who == address(pool) || who == address(token) || who == address(this)) return;
        uint64 dl = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gatePk, pool.ticketDigest(id, who, dl));
        try pool.claim(id, who, dl, v, r, s) {
            paidOut += perClaim;
            claimCount += 1;
        } catch {}
    }

    function doCancel() external {
        try pool.cancel(id) {} catch {}
    }

    function doWithdraw() external {
        uint256 before = token.balanceOf(address(this));
        try pool.withdraw(id) {
            refunded += token.balanceOf(address(this)) - before;
        } catch {}
    }

    function doWarp(uint32 delta) external {
        vm.warp(block.timestamp + (uint256(delta) % 6 hours) + 1);
    }
}

contract GiftPoolInvariantTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    GiftPool internal pool;
    MockB20 internal token;
    PoolHandler internal handler;

    function setUp() public {
        pool = new GiftPool();
        token = new MockB20("NVDAc");
        handler = new PoolHandler(pool, token, 0x6A7E, 25, 3e7, uint64(block.timestamp + 300 days));
    }

    /// Only the handler is driven; direct fuzzing of the mock token would let the run mint its
    /// way around the accounting it is supposed to check.
    function targetContracts() public view returns (address[] memory addrs) {
        addrs = new address[](1);
        addrs[0] = address(handler);
    }

    /// The handler really drives the pool - without this the invariants above could pass on a
    /// run where every action silently no-opped.
    function test_handler_actually_claims_cancels_and_refunds() public {
        for (uint256 i = 0; i < 5; ++i) handler.doClaim(i);
        require(handler.claimCount() == 5, "claims landed");
        require(handler.paidOut() == 5 * handler.perClaim(), "payouts tracked");
        handler.doClaim(1); // same seed, same address: refused, counter unchanged
        require(handler.claimCount() == 5, "no double claim");
        handler.doCancel();
        handler.doWithdraw();
        require(handler.refunded() == handler.perClaim() * (handler.slots() - 5), "remainder home");
        require(token.balanceOf(address(pool)) == 0, "pool empty");
    }

    /// Nothing appears and nothing disappears: what went in is held, paid out, or refunded.
    function invariant_tokens_are_conserved() public view {
        require(
            token.balanceOf(address(pool)) + handler.paidOut() + handler.refunded() == handler.deposited(),
            "conservation"
        );
    }

    /// While the leg is still funded, the pool holds at least everything it can still be asked for.
    function invariant_pool_is_solvent() public view {
        GiftPool.Leg[] memory legs = pool.legsOf(handler.id());
        if (legs[0].withdrawn) return;
        (,,, uint32 claimed,,,) = pool.pools(handler.id());
        require(
            token.balanceOf(address(pool)) >= legs[0].amountPerClaim * (handler.slots() - claimed), "solvency"
        );
    }

    /// The onchain claim counter never drifts from the payouts the handler actually observed.
    function invariant_claim_count_matches_payouts() public view {
        (,,, uint32 claimed,,,) = pool.pools(handler.id());
        require(uint256(claimed) == handler.claimCount(), "claim count");
        require(handler.paidOut() == handler.perClaim() * handler.claimCount(), "payout total");
    }

    /// Slots can never be oversold.
    function invariant_claims_never_exceed_slots() public view {
        (,,, uint32 claimed,,,) = pool.pools(handler.id());
        require(claimed <= handler.slots(), "oversold");
    }
}
