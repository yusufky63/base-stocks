// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 surface the pool needs. B20 tokenized stocks are plain ERC-20s with
/// issuer transfer policies; a policy block or a pause simply makes the transfer revert here.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title  GiftPool
 * @notice One deposit, many equal claims. The creator locks a fixed amount of one or more
 *         ERC-20s per claim slot; each eligible address takes exactly one share. Claims are
 *         open to anyone, gated by a link key, or gated by a signer that vouches for offchain
 *         eligibility (quests, allowlists) — all three are the same code path, they only differ
 *         in who holds the key behind `gate`. The creator can stop the pool and take the
 *         unclaimed remainder back.
 *
 * @dev    Ownerless by design: no admin, no pause, no upgrade, no fee, no token allowlist. The
 *         contract can only ever pay a claimant their exact share or return the unclaimed
 *         remainder to the creator.
 *
 *         Accounting is in raw token units and never divides: the creator states the amount per
 *         claim and the contract multiplies, so nothing rounds and no dust is stranded. The
 *         invariant that follows is `balanceOf(pool) >= amountPerClaim * (slots - claimed)` for
 *         every leg that has not been withdrawn.
 *
 *         B20 specifics: `balanceOf` is the RAW balance and does not rebase — a corporate action
 *         changes the asset's `multiplier`, not the units held here — so a share promised at
 *         creation is the same share at claim time. Issuer transfer policies apply on the way in
 *         and out; a blocked or paused transfer reverts and the pool stays intact for a retry.
 *         Because a pause could otherwise trap the whole package, closing a pool is two steps:
 *         `cancel` only flips a flag and always succeeds, `withdrawLeg` moves one token at a time.
 */
contract GiftPool {
    struct Pool {
        address creator;
        /// @notice address(0) = open to anyone (one claim per address, self-claim only).
        ///         Otherwise every claim carries an EIP-712 ticket signed by this address.
        address gate;
        uint32 slots;
        uint32 claimed;
        uint64 expiry;
        /// @notice The creator cannot cancel before this timestamp (0 = cancellable at once).
        uint64 lockedUntil;
        bool cancelled;
    }

    struct Leg {
        address token;
        uint256 amountPerClaim;
        bool withdrawn;
    }

    mapping(bytes32 id => Pool) public pools;
    mapping(bytes32 id => Leg[]) private _legs;
    mapping(bytes32 id => mapping(address claimant => bool)) public hasClaimed;

    /// @dev EIP-712 domain separator, bound to this chain and contract.
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant TICKET_TYPEHASH = keccak256("Ticket(bytes32 poolId,address recipient,uint64 deadline)");
    uint256 public constant MAX_POOL_DURATION = 365 days;
    uint256 public constant MAX_LEGS = 8;
    /// @dev secp256k1n / 2. An `s` above this is the malleable twin of a valid signature.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    uint256 private _entered = 1;

    event PoolCreated(
        bytes32 indexed id,
        address indexed creator,
        address indexed gate,
        uint32 slots,
        uint64 expiry,
        uint64 lockedUntil,
        bytes32 memoRef
    );
    event PoolLeg(bytes32 indexed id, address indexed token, uint256 amountPerClaim);
    event PoolClaimed(bytes32 indexed id, address indexed recipient, uint32 index);
    event PoolCancelled(bytes32 indexed id, address indexed creator);
    event PoolWithdrawn(bytes32 indexed id, address indexed token, uint256 amount);

    error AlreadyClaimed();
    error AlreadyWithdrawn();
    error AmountZero();
    error BadExpiry();
    error BadLegs();
    error BadSignature();
    error DuplicateToken();
    error NotCreator();
    error PoolClosed();
    error PoolEmpty();
    error PoolExists();
    error PoolUnknown();
    error Reentered();
    error StillLocked();
    error StillOpen();
    error TicketExpired();
    error TransferFailed();
    error UnsupportedToken();

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
                keccak256(bytes("BStocks GiftPool")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /* ------------------------------- views ------------------------------- */

    /// @notice Pool id, predictable before the transaction so the app can prepare the share link.
    function poolId(address creator, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function legsOf(bytes32 id) external view returns (Leg[] memory) {
        return _legs[id];
    }

    function legCount(bytes32 id) external view returns (uint256) {
        return _legs[id].length;
    }

    /// @notice Slots claimable right now: 0 once the pool is cancelled, expired or exhausted.
    function remainingSlots(bytes32 id) external view returns (uint32) {
        Pool memory p = pools[id];
        if (p.creator == address(0) || p.cancelled || block.timestamp > p.expiry) return 0;
        return p.slots - p.claimed;
    }

    /// @notice The digest a gated claim must be signed over; the app signs this offchain.
    function ticketDigest(bytes32 id, address recipient, uint64 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(TICKET_TYPEHASH, id, recipient, deadline))
            )
        );
    }

    /* ------------------------------- create ------------------------------ */

    /**
     * @notice Fund a pool of `slots` equal shares, each paying `amountsPerClaim[i]` of `tokens[i]`.
     * @param salt   Any value this creator has not used before; fixes the pool id up front.
     * @param gate   address(0) for an open pool, else the address whose signature every claim
     *               ticket must carry (an ephemeral link key, or a campaign signer).
     * @param memoRef Offchain reconciliation reference (hash of the app-side pool id), event-only.
     * @dev   Requires prior approvals for slots × amountPerClaim of each token; approve and
     *        create batch atomically on Base Account.
     */
    function create(
        bytes32 salt,
        address gate,
        uint32 slots,
        uint64 expiry,
        uint64 lockedUntil,
        address[] calldata tokens,
        uint256[] calldata amountsPerClaim,
        bytes32 memoRef
    ) external nonReentrant returns (bytes32 id) {
        uint256 n = tokens.length;
        if (n == 0 || n > MAX_LEGS || n != amountsPerClaim.length) revert BadLegs();
        if (slots == 0) revert AmountZero();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_POOL_DURATION) revert BadExpiry();
        if (lockedUntil > expiry) revert BadExpiry();

        id = poolId(msg.sender, salt);
        if (pools[id].creator != address(0)) revert PoolExists();
        pools[id] = Pool({
            creator: msg.sender,
            gate: gate,
            slots: slots,
            claimed: 0,
            expiry: expiry,
            lockedUntil: lockedUntil,
            cancelled: false
        });
        emit PoolCreated(id, msg.sender, gate, slots, expiry, lockedUntil, memoRef);

        for (uint256 i = 0; i < n; ++i) {
            address token = tokens[i];
            uint256 per = amountsPerClaim[i];
            if (per == 0) revert AmountZero();
            for (uint256 j = 0; j < i; ++j) {
                if (tokens[j] == token) revert DuplicateToken();
            }
            uint256 total = per * slots; // checked arithmetic: an overflow reverts
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            if (!IERC20(token).transferFrom(msg.sender, address(this), total)) revert TransferFailed();
            // Exactly `total` must land. Rejects fee-on-transfer and rebasing tokens, whose
            // per-claim accounting this contract cannot honour.
            if (IERC20(token).balanceOf(address(this)) - balanceBefore != total) revert UnsupportedToken();
            _legs[id].push(Leg({token: token, amountPerClaim: per, withdrawn: false}));
            emit PoolLeg(id, token, per);
        }
    }

    /* -------------------------------- claim ------------------------------ */

    /**
     * @notice Take one share of the pool.
     * @dev Open pools (gate == 0) are self-claim only, so nobody can spend a pool on addresses of
     *      their own choosing. Gated pools accept a submission from anyone — a relayer or a
     *      sponsored smart account — because the ticket binds the recipient.
     */
    function claim(bytes32 id, address recipient, uint64 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        Pool storage p = pools[id];
        if (p.creator == address(0)) revert PoolUnknown();
        if (p.cancelled || block.timestamp > p.expiry) revert PoolClosed();
        if (p.claimed >= p.slots) revert PoolEmpty();
        if (recipient == address(0)) revert BadSignature();
        if (hasClaimed[id][recipient]) revert AlreadyClaimed();

        address gate = p.gate;
        if (gate == address(0)) {
            if (recipient != msg.sender) revert BadSignature();
        } else {
            if (block.timestamp > deadline) revert TicketExpired();
            if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert BadSignature();
            if (ecrecover(ticketDigest(id, recipient, deadline), v, r, s) != gate) revert BadSignature();
        }

        hasClaimed[id][recipient] = true;
        uint32 index = p.claimed;
        p.claimed = index + 1;

        Leg[] storage legs = _legs[id];
        uint256 n = legs.length;
        for (uint256 i = 0; i < n; ++i) {
            if (!IERC20(legs[i].token).transfer(recipient, legs[i].amountPerClaim)) revert TransferFailed();
        }
        emit PoolClaimed(id, recipient, index);
    }

    /* ------------------------------- closing ----------------------------- */

    /// @notice Stop the pool. No transfer happens here, so a paused or policy-blocked token can
    ///         never keep the creator from closing it; the tokens come back with `withdraw`.
    function cancel(bytes32 id) external {
        Pool storage p = pools[id];
        if (p.creator == address(0)) revert PoolUnknown();
        if (p.creator != msg.sender) revert NotCreator();
        if (p.cancelled) revert PoolClosed();
        if (block.timestamp < p.lockedUntil) revert StillLocked();
        p.cancelled = true;
        emit PoolCancelled(id, msg.sender);
    }

    /// @notice Return one token's unclaimed remainder to the creator, once the pool is cancelled
    ///         or expired. Per leg, so one stuck token cannot trap the others.
    function withdrawLeg(bytes32 id, uint256 legIndex) public nonReentrant {
        Pool storage p = pools[id];
        if (p.creator == address(0)) revert PoolUnknown();
        if (p.creator != msg.sender) revert NotCreator();
        if (!p.cancelled && block.timestamp <= p.expiry) revert StillOpen();
        Leg storage leg = _legs[id][legIndex];
        if (leg.withdrawn) revert AlreadyWithdrawn();
        leg.withdrawn = true;
        uint256 amount = leg.amountPerClaim * (p.slots - p.claimed);
        if (amount != 0 && !IERC20(leg.token).transfer(p.creator, amount)) revert TransferFailed();
        emit PoolWithdrawn(id, leg.token, amount);
    }

    /// @notice Every remaining leg at once — the normal path. Falls back to `withdrawLeg` when one
    ///         token's transfers are paused by its issuer.
    function withdraw(bytes32 id) external {
        if (pools[id].creator == address(0)) revert PoolUnknown();
        uint256 n = _legs[id].length;
        for (uint256 i = 0; i < n; ++i) {
            if (!_legs[id][i].withdrawn) withdrawLeg(id, i);
        }
    }
}
