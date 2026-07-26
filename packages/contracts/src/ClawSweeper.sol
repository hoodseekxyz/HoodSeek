// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// DRAFT — unaudited, not deployed. Phase 7 skeleton for `clawsweeper` per
// Manifesto v3 ("MEV/arbitrage sweeper bot skeleton — agents scan mempool
// and auto-trade... injects proceeds into dividend pool"). Same security
// posture as ajan1-HoodSeekV1.sol: guardian multisig + timelock gates all
// config, single-file / no external imports, deploys via
// `cast send --create` on Robinhood Chain (4663) — forge script does not
// work on this chain. sweep() only ever moves capital this contract
// already holds; it never touches a user's balance or a user's pending
// transaction.
//
// NO-SANDWICH GUARDRAIL — this is the load-bearing design constraint the
// CEO directive called for, so it is spelled out here rather than left
// implicit:
//   A sandwich attack requires coordinating two trades AROUND one specific
//   pending victim transaction (buy ahead of it, sell after), profiting
//   from that victim's own slippage. sweep() structurally cannot do this:
//     1. It only trades against a fixed, guardian-approved router
//        whitelist (isApprovedRouter) — it cannot be pointed at an
//        arbitrary contract, so it cannot be repointed at a victim's pool
//        the moment a juicy pending tx appears.
//     2. Both legs execute back-to-back inside one atomic call with no
//        external calldata path for a caller to interleave a third party's
//        transaction between them or to target a specific counterparty.
//     3. It reverts unless the contract's OWN token balance is larger
//        afterwards by at least minProfitBps — a floor computed purely
//        from this contract's own before/after balance, with no reference
//        to any other account's trade, so there is nothing to tune against
//        a specific victim.
//   In short: sweep() can only harvest price divergence that already
//   exists between two approved pools: pure external arbitrage, not
//   value extracted from a specific user's order. This is a contract-level
//   guardrail, not a full guarantee — the off-chain sweeper bot that
//   decides *which* opportunities to submit is out of scope for this
//   on-chain draft and needs its own review before going live.
//
// KNOWN GAPS (flag for Red Team, same as WillTokenV6 in phase3-roadmap.md):
//   - No reentrancy guard on sweep(). Token is expected to be a plain
//     ERC20 (like $WILL) with no external callback on transfer/approve,
//     so there is no reentrancy surface today — but this assumption must
//     be re-verified for every token this is ever pointed at.
//   - Router/path validation is minimal (whitelisted router address only,
//     not a whitelisted token pair) — a compromised sweeper agent could
//     still choose a bad `intermediate` token. Registering a sweeper is
//     already a trusted, guardian-gated action, same trust tier as
//     HoodSeekV1.isAgent, but this should be tightened before mainnet.

interface IDexRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract ClawsweeperDraft {
    uint256 public constant TIMELOCK_DELAY = 2 days;
    uint256 public constant MIN_GUARDIANS = 3;
    uint256 public constant MIN_THRESHOLD = 2;
    uint256 public constant MAX_PROFIT_BPS = 10_000; // 100% — sanity ceiling on config, not a target

    mapping(address => bool) public isGuardian;
    uint256 public guardianCount;
    uint256 public threshold;

    // Per-action round counter — same pattern as HoodSeekV1.actionRound.
    mapping(bytes32 => uint256) public actionRound;

    struct Proposal {
        uint256 readyAt;
        bool executed;
        address[] approvers;
        mapping(address => bool) approvedBy;
    }
    mapping(bytes32 => Proposal) private proposals;

    // Off-chain bots that scan for arbitrage and call sweep(). Registration
    // is guardian-gated exactly like HoodSeekV1.isAgent.
    mapping(address => bool) public isSweeper;

    // sweep() may only route through these — the core no-sandwich guardrail.
    mapping(address => bool) public isApprovedRouter;

    address public dividendPool;
    uint256 public minProfitBps = 30; // 0.3% floor, guardian-adjustable
    bool public paused;

    event GuardianUpdated(address indexed guardian, bool status);
    event ThresholdUpdated(uint256 newThreshold);
    event ProposalApproved(bytes32 indexed salt, bytes32 actionId, address indexed guardian, uint256 liveApprovals);
    event SweeperUpdated(address indexed sweeper, bool status);
    event RouterApproved(address indexed router, bool status);
    event DividendPoolUpdated(address indexed pool);
    event MinProfitBpsUpdated(uint256 newMinProfitBps);
    event Swept(
        address indexed sweeper,
        address indexed token,
        uint256 amountIn,
        uint256 profit,
        address routerBuy,
        address routerSell
    );
    event Paused(address indexed guardian);
    event Unpaused();

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "not guardian");
        _;
    }

    modifier onlySweeper() {
        require(isSweeper[msg.sender], "not sweeper");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(address[] memory initialGuardians, uint256 threshold_, address dividendPool_) {
        require(initialGuardians.length >= MIN_GUARDIANS, "min 3 guardians");
        require(threshold_ >= MIN_THRESHOLD, "min threshold 2");
        require(threshold_ < initialGuardians.length, "threshold must be < guardian count");
        require(dividendPool_ != address(0), "zero dividend pool");

        for (uint256 i = 0; i < initialGuardians.length; i++) {
            address g = initialGuardians[i];
            require(g != address(0), "zero guardian");
            require(!isGuardian[g], "duplicate guardian");
            isGuardian[g] = true;
        }
        guardianCount = initialGuardians.length;
        threshold = threshold_;
        dividendPool = dividendPool_;
    }

    // ============ Guardian multisig + timelock core (identical pattern to HoodSeekV1) ============

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

    // ============ Emergency pause — same low-friction/high-friction split as HoodSeekV1 ============

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

    // ============ Guardian-gated configuration ============

    function setGuardian(address guardian, bool status) external {
        require(guardian != address(0), "zero guardian");
        _consume(keccak256(abi.encode("SET_GUARDIAN", guardian, status)));

        if (status && !isGuardian[guardian]) {
            isGuardian[guardian] = true;
            guardianCount += 1;
        } else if (!status && isGuardian[guardian]) {
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

    function setSweeper(address sweeper, bool status) external {
        require(sweeper != address(0), "zero sweeper");
        _consume(keccak256(abi.encode("SET_SWEEPER", sweeper, status)));
        isSweeper[sweeper] = status;
        emit SweeperUpdated(sweeper, status);
    }

    function setApprovedRouter(address router, bool status) external {
        require(router != address(0), "zero router");
        _consume(keccak256(abi.encode("SET_APPROVED_ROUTER", router, status)));
        isApprovedRouter[router] = status;
        emit RouterApproved(router, status);
    }

    function setDividendPool(address pool) external {
        require(pool != address(0), "zero dividend pool");
        _consume(keccak256(abi.encode("SET_DIVIDEND_POOL", pool)));
        dividendPool = pool;
        emit DividendPoolUpdated(pool);
    }

    function setMinProfitBps(uint256 newMinProfitBps) external {
        require(newMinProfitBps <= MAX_PROFIT_BPS, "bps too high");
        _consume(keccak256(abi.encode("SET_MIN_PROFIT_BPS", newMinProfitBps)));
        minProfitBps = newMinProfitBps;
        emit MinProfitBpsUpdated(newMinProfitBps);
    }

    // ============ Arbitrage sweep — the clawsweeper core ============
    //
    // Executes two swap legs back-to-back in one atomic call: sell `token`
    // for `intermediate` on `routerBuy`, then sell `intermediate` back for
    // `token` on `routerSell`. Reverts unless this contract's own `token`
    // balance is larger afterwards by at least `minProfitBps`. Only
    // registered sweeper agents may call this, and both routers must
    // already be on the guardian-approved whitelist. Net profit is
    // forwarded to `dividendPool`; principal stays here for the next sweep.
    // See the NO-SANDWICH GUARDRAIL note at the top of this file.

    function sweep(
        address token,
        address intermediate,
        uint256 amountIn,
        address routerBuy,
        address routerSell,
        uint256 deadline
    ) external onlySweeper whenNotPaused returns (uint256 profit) {
        require(isApprovedRouter[routerBuy], "routerBuy not approved");
        require(isApprovedRouter[routerSell], "routerSell not approved");
        require(amountIn > 0, "zero amount in");

        uint256 startBalance = IERC20Like(token).balanceOf(address(this));
        require(startBalance >= amountIn, "insufficient balance");

        address[] memory pathOut = new address[](2);
        pathOut[0] = token;
        pathOut[1] = intermediate;
        IERC20Like(token).approve(routerBuy, amountIn);
        IDexRouter(routerBuy).swapExactTokensForTokens(amountIn, 0, pathOut, address(this), deadline);

        uint256 intermediateReceived = IERC20Like(intermediate).balanceOf(address(this));

        address[] memory pathBack = new address[](2);
        pathBack[0] = intermediate;
        pathBack[1] = token;
        IERC20Like(intermediate).approve(routerSell, intermediateReceived);
        IDexRouter(routerSell).swapExactTokensForTokens(intermediateReceived, 0, pathBack, address(this), deadline);

        // Re-read actual balance rather than trusting router-reported
        // output amounts — defends against a router that misreports.
        uint256 endBalance = IERC20Like(token).balanceOf(address(this));
        require(endBalance > startBalance, "not profitable");

        profit = endBalance - startBalance;
        require(profit * 10_000 >= startBalance * minProfitBps, "below min profit bps");

        bool ok = IERC20Like(token).transfer(dividendPool, profit);
        require(ok, "dividend transfer failed");

        emit Swept(msg.sender, token, amountIn, profit, routerBuy, routerSell);
    }

    // ============ Guardian-gated recovery (stuck dust from a partial/failed sweep) ============

    function rescueToken(address token, address to, uint256 amount) external {
        require(to != address(0), "zero recipient");
        _consume(keccak256(abi.encode("RESCUE_TOKEN", token, to, amount)));
        bool ok = IERC20Like(token).transfer(to, amount);
        require(ok, "rescue transfer failed");
    }
}
