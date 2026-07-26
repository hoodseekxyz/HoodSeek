// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// RENAMED 2026-07-25 — Option B total rebrand (DISPATCH.md Phase 11):
// ajan1-WillTokenV5.sol -> ajan1-HoodSeekV1.sol, contract WillTokenV5 ->
// HoodSeekV1, EIP-712 domain name string updated to match. No holders
// existed under the old identity (test wallets only), so this is a
// same-code rename ahead of a fresh deploy, not a migration. Logic below
// is otherwise unchanged from WillTokenV5 — history preserved as-is.
//
// DRAFT v5 — unaudited. Fixes vs ajan1-WillTokenV4.sol (Red Team review
// 2026-07-24): removes the dead `owner` state — it was set in the
// constructor and had a transferOwnership() function + event, but no
// function in the contract ever checked its value for authorization
// (v2 replaced single-EOA ownership with the guardian multisig and
// left `owner` behind as inert, misleading state). Governance is
// entirely guardian-multisig-gated; there was never a separate
// owner-level backdoor, so this is a no-behavior-change cleanup, not a
// security fix. Single-file / no external imports — still deploys via
// `cast send --create` on Robinhood Chain (4663), no forge script needed.
interface ILPToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract HoodSeekV1 {
    // Informational only — NOT an ERC20 name()/symbol() pair. This
    // contract has no decimals(), no Transfer event, no approve/transfer;
    // adding those two functions doesn't make it ERC20-shaped, it just
    // gives HOSE_TOKEN_V1_ABI-style consumers a way to display identity.
    string public constant NAME = "HoodSeek";
    string public constant SYMBOL = "HOSE";

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant TIMELOCK_DELAY = 2 days;
    uint256 public constant MIN_GUARDIANS = 3;
    uint256 public constant MIN_THRESHOLD = 2;

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "AgentIntent(address from,address to,uint256 amount,uint256 nonce,uint256 deadline,bytes32 taskId)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => bool) public isGuardian;
    uint256 public guardianCount;
    uint256 public threshold;

    // Per-action round counter. Bumped every time _consume() succeeds for
    // that salt, so the same salt always maps to a fresh Proposal after
    // its previous round has executed.
    mapping(bytes32 => uint256) public actionRound;

    struct Proposal {
        uint256 readyAt;
        bool executed;
        address[] approvers;
        mapping(address => bool) approvedBy;
    }
    mapping(bytes32 => Proposal) private proposals;

    mapping(address => bool) public isAgent;
    mapping(address => bool) public isBurnAdmin;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public nonces;
    uint256 public totalSupply;

    address public lpToken;
    bool public burnEnabled;
    bool public paused;

    // Reserved for Ajan-6's A2A fee/treasury-routing model — not wired yet.
    address public treasury;

    event GuardianUpdated(address indexed guardian, bool status);
    event ThresholdUpdated(uint256 newThreshold);
    event ProposalApproved(bytes32 indexed salt, bytes32 actionId, address indexed guardian, uint256 liveApprovals);
    event AgentRegistered(address indexed agent);
    event AgentRevoked(address indexed agent);
    event IntentExecuted(address indexed from, address indexed to, uint256 amount, bytes32 taskId);
    event BurnEnabled();
    event LPTokenSet(address indexed lpToken);
    event LPBurned(address indexed admin, address indexed lpToken, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event Paused(address indexed guardian);
    event Unpaused();

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "not guardian");
        _;
    }

    modifier onlyAgent() {
        require(isAgent[msg.sender], "not agent");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(
        uint256 initialSupply,
        address treasury_,
        address[] memory initialGuardians,
        uint256 threshold_
    ) {
        require(initialGuardians.length >= MIN_GUARDIANS, "min 3 guardians");
        require(threshold_ >= MIN_THRESHOLD, "min threshold 2");
        require(threshold_ < initialGuardians.length, "threshold must be < guardian count");

        treasury = treasury_;
        balanceOf[msg.sender] = initialSupply;
        totalSupply = initialSupply;

        for (uint256 i = 0; i < initialGuardians.length; i++) {
            address g = initialGuardians[i];
            require(g != address(0), "zero guardian");
            require(!isGuardian[g], "duplicate guardian");
            isGuardian[g] = true;
        }
        guardianCount = initialGuardians.length;
        threshold = threshold_;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("HoodSeekV1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ============ Guardian multisig + timelock core ============
    // Guardians always approve/execute using the fixed semantic `salt` for
    // an action (e.g. keccak256(abi.encode("REGISTER_AGENT", agent))) —
    // never a round-specific id. The contract resolves `salt` to the
    // current round's actionId internally. "Live" approvals only count
    // guardians who are STILL guardians right now. Once live approvals
    // reach `threshold`, a timelock starts; after it elapses (and live
    // approvals still meet threshold), anyone may call the matching
    // function, which bumps the round so the same salt starts fresh next
    // time it's needed.

    function _actionId(bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(salt, actionRound[salt]));
    }

    function approve(bytes32 salt) external onlyGuardian {
        bytes32 actionId = _actionId(salt);
        Proposal storage p = proposals[actionId];
        require(!p.executed, "already executed");
        require(!p.approvedBy[msg.sender], "already approved");

        p.approvedBy[msg.sender] = true;
        p.approvers.push(msg.sender);

        uint256 live = _liveApprovals(actionId);
        if (live >= threshold && p.readyAt == 0) {
            p.readyAt = block.timestamp + TIMELOCK_DELAY;
        }
        emit ProposalApproved(salt, actionId, msg.sender, live);
    }

    function _liveApprovals(bytes32 actionId) internal view returns (uint256 count) {
        address[] storage approvers = proposals[actionId].approvers;
        for (uint256 i = 0; i < approvers.length; i++) {
            if (isGuardian[approvers[i]]) count++;
        }
    }

    function proposalStatus(bytes32 salt)
        external
        view
        returns (uint256 liveApprovals, uint256 readyAt, bool executed, uint256 round)
    {
        bytes32 actionId = _actionId(salt);
        Proposal storage p = proposals[actionId];
        return (_liveApprovals(actionId), p.readyAt, p.executed, actionRound[salt]);
    }

    function _consume(bytes32 salt) internal {
        bytes32 actionId = _actionId(salt);
        Proposal storage p = proposals[actionId];
        require(_liveApprovals(actionId) >= threshold, "insufficient live approvals");
        require(p.readyAt != 0 && block.timestamp >= p.readyAt, "timelock not elapsed");
        require(!p.executed, "already executed");
        p.executed = true;
        actionRound[salt] += 1;
    }

    // ============ Emergency pause — no timelock, single guardian ============
    // Deliberately low-friction: any one guardian can freeze value-moving
    // functions immediately. A guardian abusing this to grief the system
    // is only a temporary DoS (fixable by revoking them through normal
    // governance) — the trade-off favors being able to stop an active
    // exploit in one transaction instead of waiting out the timelock.
    // Unpausing goes through the full multisig + timelock so a single
    // compromised guardian cannot both pause AND immediately resume with
    // altered state. Because unpause() goes through the round-based
    // _consume(), a second (or Nth) pause later in the contract's life
    // starts a fresh proposal instead of permanently reverting.

    function pause() external onlyGuardian {
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        require(paused, "not paused");
        _consume(keccak256(abi.encode("UNPAUSE")));
        paused = false;
        emit Unpaused();
    }

    // ============ Guardian-gated administrative actions ============

    function setGuardian(address guardian, bool status) external {
        require(guardian != address(0), "zero guardian");
        _consume(keccak256(abi.encode("SET_GUARDIAN", guardian, status)));

        if (status && !isGuardian[guardian]) {
            isGuardian[guardian] = true;
            guardianCount += 1;
        } else if (!status && isGuardian[guardian]) {
            // Strictly greater, never equal — guarantees guardianCount
            // stays above threshold, so unanimity (and the resulting
            // deadlock where removal requires the removed guardian's own
            // vote) can never be reached through governance either.
            require(guardianCount - 1 > threshold, "would reach unanimity");
            isGuardian[guardian] = false;
            guardianCount -= 1;
        }
        emit GuardianUpdated(guardian, status);
    }

    function setThreshold(uint256 newThreshold) external {
        require(newThreshold >= MIN_THRESHOLD && newThreshold < guardianCount, "bad threshold");
        _consume(keccak256(abi.encode("SET_THRESHOLD", newThreshold)));
        threshold = newThreshold;
        emit ThresholdUpdated(newThreshold);
    }

    function registerAgent(address agent) external {
        require(agent != address(0), "zero agent");
        _consume(keccak256(abi.encode("REGISTER_AGENT", agent)));
        isAgent[agent] = true;
        emit AgentRegistered(agent);
    }

    function revokeAgent(address agent) external {
        _consume(keccak256(abi.encode("REVOKE_AGENT", agent)));
        isAgent[agent] = false;
        emit AgentRevoked(agent);
    }

    function setBurnAdmin(address admin, bool status) external {
        require(admin != address(0), "zero admin");
        _consume(keccak256(abi.encode("SET_BURN_ADMIN", admin, status)));
        isBurnAdmin[admin] = status;
    }

    function setTreasury(address treasury_) external {
        require(treasury_ != address(0), "zero treasury");
        _consume(keccak256(abi.encode("SET_TREASURY", treasury_)));
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setLPToken(address lpToken_) external {
        require(lpToken_ != address(0), "zero lp token");
        _consume(keccak256(abi.encode("SET_LP_TOKEN", lpToken_)));
        lpToken = lpToken_;
        emit LPTokenSet(lpToken_);
    }

    function enableBurn() external {
        _consume(keccak256(abi.encode("ENABLE_BURN")));
        burnEnabled = true;
        emit BurnEnabled();
    }

    // ============ Intent-based transfer ============

    function executeIntent(
        address from,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes32 taskId,
        bytes calldata signature
    ) external onlyAgent whenNotPaused {
        require(to != address(0), "zero recipient");
        require(block.timestamp <= deadline, "intent expired");

        uint256 nonce = nonces[from]++;
        bytes32 structHash = keccak256(
            abi.encode(INTENT_TYPEHASH, from, to, amount, nonce, deadline, taskId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address signer = _recoverSigner(digest, signature);
        require(signer != address(0) && signer == from, "invalid signature");

        _transfer(from, to, amount);
        emit IntentExecuted(from, to, amount, taskId);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    // ============ LP burn — burns real LP token balance held by this contract ============

    function burnLP(uint256 amount) external whenNotPaused {
        require(isBurnAdmin[msg.sender], "not burn admin");
        require(burnEnabled, "burn disabled");
        require(lpToken != address(0), "lp token not set");

        bool ok = ILPToken(lpToken).transfer(BURN_ADDRESS, amount);
        require(ok, "lp transfer failed");
        emit LPBurned(msg.sender, lpToken, amount);
    }

    // ============ ECDSA recovery (inlined, malleability-guarded) ============

    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "invalid s value"
        );
        require(v == 27 || v == 28, "invalid v value");

        return ecrecover(digest, v, r, s);
    }
}
