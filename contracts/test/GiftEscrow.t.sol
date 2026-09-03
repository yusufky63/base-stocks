// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GiftEscrow} from "../src/GiftEscrow.sol";

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

/// @dev ERC-20 with B20-like failure modes: issuer pause and per-address policy blocks.
contract MockB20 {
    string public constant symbol = "NVDAc";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;
    mapping(address => bool) public blockedReceiver;

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
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Token that reenters the escrow during the claim payout.
contract ReentrantToken {
    GiftEscrow public escrow;
    bytes32 public targetId;
    mapping(address => uint256) public balanceOf;

    function setTarget(GiftEscrow e, bytes32 id) external {
        escrow = e;
        targetId = id;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        return true;
    }

    function transfer(address, uint256) external returns (bool) {
        if (address(escrow) != address(0)) {
            escrow.reclaim(targetId); // must revert with Reentered
        }
        return true;
    }
}

contract GiftEscrowTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    GiftEscrow internal escrow;
    MockB20 internal token;

    uint256 internal constant CLAIM_PK = 0xA11CE;
    address internal claimKey;
    address internal constant SENDER = address(0x5E9d3d);
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant STRANGER = address(0xD15EA5E);
    uint256 internal constant AMOUNT = 5e8; // 5 tokens at 8 decimals
    uint64 internal expiry;

    function setUp() public {
        escrow = new GiftEscrow();
        token = new MockB20();
        claimKey = vm.addr(CLAIM_PK);
        expiry = uint64(block.timestamp + 7 days);
        token.mint(SENDER, 100e8);
        vm.prank(SENDER);
        token.approve(address(escrow), type(uint256).max);
    }

    /* ---------- helpers ---------- */

    function _create() internal returns (bytes32 id) {
        vm.prank(SENDER);
        id = escrow.create(address(token), AMOUNT, claimKey, expiry, keccak256("memo"));
    }

    function _sig(bytes32 id, address recipient, uint256 pk) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), keccak256(abi.encode(escrow.CLAIM_TYPEHASH(), id, recipient)))
        );
        return vm.sign(pk, digest);
    }

    function _assertEq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    /* ---------- create ---------- */

    function test_create_locks_tokens_and_stores_gift() public {
        bytes32 id = _create();
        _assertEq(token.balanceOf(address(escrow)), AMOUNT, "escrow holds amount");
        _assertEq(token.balanceOf(SENDER), 100e8 - AMOUNT, "sender debited");
        (address gSender, address gToken, uint64 gExpiry, uint256 gAmount) = escrow.gifts(id);
        require(gSender == SENDER && gToken == address(token) && gExpiry == expiry && gAmount == AMOUNT, "gift stored");
        require(id == escrow.giftId(claimKey), "id from claim key");
    }

    function test_create_rejects_zero_amount() public {
        vm.prank(SENDER);
        vm.expectRevert(GiftEscrow.AmountZero.selector);
        escrow.create(address(token), 0, claimKey, expiry, 0);
    }

    function test_create_rejects_zero_claim_key() public {
        vm.prank(SENDER);
        vm.expectRevert(GiftEscrow.BadSignature.selector);
        escrow.create(address(token), AMOUNT, address(0), expiry, 0);
    }

    function test_create_rejects_past_and_far_expiry() public {
        vm.startPrank(SENDER);
        vm.expectRevert(GiftEscrow.BadExpiry.selector);
        escrow.create(address(token), AMOUNT, claimKey, uint64(block.timestamp), 0);
        vm.expectRevert(GiftEscrow.BadExpiry.selector);
        escrow.create(address(token), AMOUNT, claimKey, uint64(block.timestamp + 91 days), 0);
        vm.stopPrank();
    }

    function test_create_rejects_duplicate_claim_key() public {
        _create();
        vm.prank(SENDER);
        vm.expectRevert(GiftEscrow.GiftExists.selector);
        escrow.create(address(token), AMOUNT, claimKey, expiry, 0);
    }

    function test_create_rejects_false_returning_token() public {
        FalseToken bad = new FalseToken();
        vm.prank(SENDER);
        vm.expectRevert(GiftEscrow.TransferFailed.selector);
        escrow.create(address(bad), AMOUNT, claimKey, expiry, 0);
    }

    /* ---------- claim ---------- */

    function test_claim_pays_recipient_and_clears() public {
        bytes32 id = _create();
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.prank(STRANGER); // anyone may submit: gas can come from a sponsor or relayer
        escrow.claim(id, RECIPIENT, v, r, s);
        _assertEq(token.balanceOf(RECIPIENT), AMOUNT, "recipient paid");
        _assertEq(token.balanceOf(address(escrow)), 0, "escrow empty");
        (address gSender,,,) = escrow.gifts(id);
        require(gSender == address(0), "gift deleted");
    }

    function test_claim_signature_binds_recipient() public {
        bytes32 id = _create();
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.expectRevert(GiftEscrow.BadSignature.selector);
        escrow.claim(id, STRANGER, v, r, s); // signature was for RECIPIENT
    }

    function test_claim_rejects_wrong_key() public {
        bytes32 id = _create();
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, 0xBAD);
        vm.expectRevert(GiftEscrow.BadSignature.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
    }

    function test_claim_rejects_after_expiry() public {
        bytes32 id = _create();
        vm.warp(uint256(expiry) + 1);
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.expectRevert(GiftEscrow.GiftExpired.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
    }

    function test_claim_twice_rejected() public {
        bytes32 id = _create();
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        escrow.claim(id, RECIPIENT, v, r, s);
        vm.expectRevert(GiftEscrow.GiftUnknown.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
    }

    function test_claim_survives_pause_and_policy_block() public {
        bytes32 id = _create();
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);

        token.setPaused(true);
        vm.expectRevert(bytes("B20: paused"));
        escrow.claim(id, RECIPIENT, v, r, s);

        token.setPaused(false);
        token.setBlockedReceiver(RECIPIENT, true);
        vm.expectRevert(bytes("B20: policy forbids"));
        escrow.claim(id, RECIPIENT, v, r, s);

        // Gift intact after both failures; retry succeeds once the issuer unblocks.
        token.setBlockedReceiver(RECIPIENT, false);
        escrow.claim(id, RECIPIENT, v, r, s);
        _assertEq(token.balanceOf(RECIPIENT), AMOUNT, "recipient paid after retry");
    }

    /* ---------- reclaim ---------- */

    function test_reclaim_by_sender_any_time() public {
        bytes32 id = _create();
        vm.prank(SENDER);
        escrow.reclaim(id); // before expiry: cancel
        _assertEq(token.balanceOf(SENDER), 100e8, "sender refunded");
    }

    function test_reclaim_after_expiry() public {
        bytes32 id = _create();
        vm.warp(uint256(expiry) + 30 days);
        vm.prank(SENDER);
        escrow.reclaim(id);
        _assertEq(token.balanceOf(SENDER), 100e8, "sender refunded after expiry");
    }

    function test_reclaim_rejects_stranger() public {
        bytes32 id = _create();
        vm.prank(STRANGER);
        vm.expectRevert(GiftEscrow.NotSender.selector);
        escrow.reclaim(id);
    }

    function test_reclaim_then_claim_rejected() public {
        bytes32 id = _create();
        vm.prank(SENDER);
        escrow.reclaim(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.expectRevert(GiftEscrow.GiftUnknown.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
    }

    /* ---------- fuzz ---------- */

    uint256 internal constant SECP_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// Any valid key, any amount, any recipient: create then claim pays exactly and clears state.
    function testFuzz_create_claim_roundtrip(uint256 pk, uint96 amount, address recipient) public {
        pk = 1 + (pk % (SECP_ORDER - 1));
        vm.assume(amount > 0);
        vm.assume(recipient != address(0) && recipient != SENDER && recipient != address(escrow) && recipient != address(token));
        address key = vm.addr(pk);
        token.mint(SENDER, amount);
        uint256 senderBefore = token.balanceOf(SENDER);
        vm.prank(SENDER);
        bytes32 id = escrow.create(address(token), amount, key, expiry, 0);
        require(token.balanceOf(address(escrow)) >= amount, "escrowed");
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, recipient, pk);
        escrow.claim(id, recipient, v, r, s);
        require(token.balanceOf(recipient) >= amount, "paid");
        require(token.balanceOf(SENDER) == senderBefore - amount, "sender net");
        (address gSender,,,) = escrow.gifts(id);
        require(gSender == address(0), "cleared");
        vm.expectRevert(GiftEscrow.GiftUnknown.selector);
        escrow.claim(id, recipient, v, r, s);
    }

    /// A signature for one recipient can never pay any other address.
    function testFuzz_signature_binds_recipient(uint256 pk, address intended, address thief) public {
        pk = 1 + (pk % (SECP_ORDER - 1));
        vm.assume(intended != thief);
        vm.assume(intended != address(0) && thief != address(0));
        address key = vm.addr(pk);
        vm.prank(SENDER);
        bytes32 id = escrow.create(address(token), AMOUNT, key, expiry, 0);
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, intended, pk);
        vm.expectRevert(GiftEscrow.BadSignature.selector);
        escrow.claim(id, thief, v, r, s);
    }

    /// After expiry no signature claims; the sender always gets everything back.
    function testFuzz_expiry_boundary(uint64 wait) public {
        bytes32 id = _create();
        uint256 t = uint256(expiry) + 1 + (uint256(wait) % 365 days);
        vm.warp(t);
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.expectRevert(GiftEscrow.GiftExpired.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
        vm.prank(SENDER);
        escrow.reclaim(id);
        _assertEq(token.balanceOf(SENDER), 100e8, "refunded in full");
    }

    /// Two gifts never collide: distinct keys, distinct ids, independent balances.
    function testFuzz_ids_are_isolated(uint256 pkA, uint256 pkB, uint96 a, uint96 b) public {
        pkA = 1 + (pkA % (SECP_ORDER - 1));
        pkB = 1 + (pkB % (SECP_ORDER - 1));
        vm.assume(pkA != pkB);
        vm.assume(a > 0 && b > 0);
        address keyA = vm.addr(pkA);
        address keyB = vm.addr(pkB);
        vm.assume(keyA != keyB);
        token.mint(SENDER, uint256(a) + uint256(b));
        vm.startPrank(SENDER);
        bytes32 idA = escrow.create(address(token), a, keyA, expiry, 0);
        bytes32 idB = escrow.create(address(token), b, keyB, expiry, 0);
        vm.stopPrank();
        require(idA != idB, "distinct ids");
        (uint8 v, bytes32 r, bytes32 s) = _sig(idA, RECIPIENT, pkA);
        escrow.claim(idA, RECIPIENT, v, r, s);
        (, , , uint256 amtB) = escrow.gifts(idB);
        require(amtB == b, "B untouched");
    }

    /* ---------- reentrancy ---------- */

    function test_claim_blocks_reentrancy() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(SENDER, AMOUNT);
        vm.prank(SENDER);
        bytes32 id = escrow.create(address(evil), AMOUNT, claimKey, expiry, 0);
        evil.setTarget(escrow, id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(id, RECIPIENT, CLAIM_PK);
        vm.expectRevert(GiftEscrow.Reentered.selector);
        escrow.claim(id, RECIPIENT, v, r, s);
    }
}
