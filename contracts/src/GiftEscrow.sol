// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 surface the escrow needs. B20 tokenized stocks are plain ERC-20s
/// with issuer transfer policies; a policy or pause simply makes the transfer revert here.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title  GiftEscrow
 * @notice Claim-link gifts for BStocks: the sender locks ERC-20 tokens against an ephemeral
 *         "claim key" whose private half lives only in the share link's URL fragment. Whoever
 *         holds the link signs the recipient address with that key; anyone may submit the claim
 *         transaction (so a paymaster-sponsored smart account, a relayer, or the recipient
 *         themselves can pay the gas). The sender can cancel at any time; after expiry only the
 *         sender can withdraw.
 *
 * @dev    Deliberately ownerless: no admin, no pause, no upgrade, no token allowlist. The
 *         contract holds nothing but gifts and can only ever pay out to the claim-signed
 *         recipient or back to the sender. B20 specifics: raw token units are locked, so
 *         corporate-action multiplier changes while in escrow accrue to whoever withdraws;
 *         issuer transfer policies apply on the way in and out — a blocked or paused transfer
 *         reverts and the gift stays intact for a later retry.
 */
contract GiftEscrow {
    struct Gift {
        address sender;
        address token;
        uint64 expiry;
        uint256 amount;
    }

    /// @notice Gift id is derived from the claim key alone, so the claim page can locate the
    ///         gift onchain from the link secret: id = keccak256(abi.encode(claimKey)).
    mapping(bytes32 id => Gift) public gifts;

    /// @dev EIP-712 domain separator, bound to this chain and contract.
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 giftId,address recipient)");
    uint256 public constant MAX_GIFT_DURATION = 90 days;

    uint256 private _entered = 1;

    event GiftCreated(bytes32 indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiry, bytes32 memoRef);
    event GiftClaimed(bytes32 indexed id, address indexed recipient, address indexed token, uint256 amount);
    event GiftReclaimed(bytes32 indexed id, address indexed sender, address indexed token, uint256 amount);

    error AmountZero();
    error BadExpiry();
    error GiftExists();
    error GiftUnknown();
    error GiftExpired();
    error NotSender();
    error BadSignature();
    error TransferFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentered();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BStocks GiftEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Derives the gift id for a claim key.
    function giftId(address claimKey) public pure returns (bytes32) {
        return keccak256(abi.encode(claimKey));
    }

    /**
     * @notice Lock `amount` of `token` claimable by whoever can sign with `claimKey`.
     * @param memoRef Offchain reconciliation reference (hash of the app-side gift id), event-only.
     * @dev Requires a prior exact approval; approve + create batch atomically on Base Account.
     */
    function create(address token, uint256 amount, address claimKey, uint64 expiry, bytes32 memoRef) external nonReentrant returns (bytes32 id) {
        if (amount == 0) revert AmountZero();
        if (claimKey == address(0)) revert BadSignature();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_GIFT_DURATION) revert BadExpiry();
        id = giftId(claimKey);
        if (gifts[id].sender != address(0)) revert GiftExists();
        gifts[id] = Gift({sender: msg.sender, token: token, expiry: expiry, amount: amount});
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit GiftCreated(id, msg.sender, token, amount, expiry, memoRef);
    }

    /**
     * @notice Pay the gift out to `recipient`. Callable by anyone carrying a claim-key signature
     *         over (giftId, recipient), so gas can come from a sponsored smart account or a relayer.
     */
    function claim(bytes32 id, address recipient, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        Gift memory g = gifts[id];
        if (g.sender == address(0)) revert GiftUnknown();
        if (block.timestamp > g.expiry) revert GiftExpired();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || giftId(signer) != id) revert BadSignature();
        delete gifts[id];
        if (!IERC20(g.token).transfer(recipient, g.amount)) revert TransferFailed();
        emit GiftClaimed(id, recipient, g.token, g.amount);
    }

    /// @notice Sender takes the gift back — any time before it is claimed (lost link, expiry, regret).
    function reclaim(bytes32 id) external nonReentrant {
        Gift memory g = gifts[id];
        if (g.sender == address(0)) revert GiftUnknown();
        if (g.sender != msg.sender) revert NotSender();
        delete gifts[id];
        if (!IERC20(g.token).transfer(g.sender, g.amount)) revert TransferFailed();
        emit GiftReclaimed(id, g.sender, g.token, g.amount);
    }
}
