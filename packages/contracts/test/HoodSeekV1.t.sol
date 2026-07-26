// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoodSeekV1} from "./ajan1-HoodSeekV1.sol";

// Minimal ERC20-like mock for burnLP tests — not part of the deploy set.
contract MockLPToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Functional/security tests beyond access-control gating (see
// ajan1-AgentRole.t.sol for guardian/agent role tests). Written in
// response to the Red Team finding (2026-07-24) that no test exercised
// the executeIntent happy path, the pause/unpause round-reuse fix, LP
// burn, or signature malleability rejection.
contract HoodSeekV1Test is Test {
    HoodSeekV1 token;
    MockLPToken lpToken;

    address guardian1 = address(0x1);
    address guardian2 = address(0x2);
    address guardian3 = address(0x3);
    address treasury = address(0x7EA5);
    address agent = address(0xA6E47);

    uint256 senderKey = 0xA11CE;
    address sender;

    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        sender = vm.addr(senderKey);

        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;

        // Deploy as `sender` so the initial supply lands on an address we
        // hold a real private key for (needed to sign EIP-712 intents).
        vm.prank(sender);
        token = new HoodSeekV1(1_000_000 ether, treasury, guardians, 2);

        lpToken = new MockLPToken();

        _registerAgent(agent);
    }

    // ============ executeIntent — happy path ============

    function test_executeIntent_validSignature_transfersBalance() public {
        uint256 amount = 100 ether;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 taskId = keccak256("task-1");
        uint256 nonce = token.nonces(sender);

        bytes memory sig = _signIntent(senderKey, sender, agent, amount, nonce, deadline, taskId);

        vm.prank(agent);
        token.executeIntent(sender, agent, amount, deadline, taskId, sig);

        assertEq(token.balanceOf(agent), amount);
        assertEq(token.balanceOf(sender), 1_000_000 ether - amount);
        assertEq(token.nonces(sender), nonce + 1);
    }

    function test_executeIntent_rejectsZeroRecipient() public {
        uint256 nonce = token.nonces(sender);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 taskId = keccak256("zero-recipient");
        bytes memory sig = _signIntent(senderKey, sender, address(0), 1 ether, nonce, deadline, taskId);

        vm.prank(agent);
        vm.expectRevert("zero recipient");
        token.executeIntent(sender, address(0), 1 ether, deadline, taskId, sig);
    }

    function test_executeIntent_rejectsMalleableSignature() public {
        uint256 amount = 1 ether;
        uint256 nonce = token.nonces(sender);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 taskId = keccak256("malleability-test");

        bytes32 structHash = keccak256(
            abi.encode(token.INTENT_TYPEHASH(), sender, agent, amount, nonce, deadline, taskId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderKey, digest);

        // vm.sign returns canonical (lower-half) s — flip to the
        // mathematically-equivalent malleable signature (s' = n - s,
        // v' flipped) and confirm the contract rejects it.
        bytes32 sMalleable = bytes32(SECP256K1_N - uint256(s));
        uint8 vMalleable = v == 27 ? 28 : 27;
        bytes memory malleableSig = abi.encodePacked(r, sMalleable, vMalleable);

        vm.prank(agent);
        vm.expectRevert("invalid s value");
        token.executeIntent(sender, agent, amount, deadline, taskId, malleableSig);
    }

    // ============ pause/unpause — round-reuse regression ============
    // This is the exact bug the v3->v4 fix targeted: unpause() using a
    // fixed actionId meant a SECOND pause/unpause cycle would revert
    // forever, permanently freezing the contract. Confirms it holds.

    function test_pauseUnpause_survivesMultipleCycles() public {
        bytes32 unpauseSalt = keccak256(abi.encode("UNPAUSE"));

        // First incident.
        vm.prank(guardian1);
        token.pause();
        assertTrue(token.paused());

        vm.prank(guardian1);
        token.approve(unpauseSalt);
        vm.prank(guardian2);
        token.approve(unpauseSalt);
        skip(2 days);
        token.unpause();
        assertFalse(token.paused());

        // Second incident — would permanently revert on the pre-v4
        // contract.
        vm.prank(guardian2);
        token.pause();
        assertTrue(token.paused());

        vm.prank(guardian1);
        token.approve(unpauseSalt);
        vm.prank(guardian3);
        token.approve(unpauseSalt);
        skip(2 days);
        token.unpause();
        assertFalse(token.paused());
    }

    function test_pause_blocksExecuteIntent() public {
        vm.prank(guardian1);
        token.pause();

        uint256 nonce = token.nonces(sender);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 taskId = keccak256("paused-test");
        bytes memory sig = _signIntent(senderKey, sender, agent, 1 ether, nonce, deadline, taskId);

        vm.prank(agent);
        vm.expectRevert("paused");
        token.executeIntent(sender, agent, 1 ether, deadline, taskId, sig);
    }

    // ============ burnLP ============

    function test_burnLP_transfersToDeadAddress() public {
        address burnAdmin = _prepareBurnAdmin();

        vm.prank(burnAdmin);
        token.burnLP(200 ether);

        assertEq(lpToken.balanceOf(token.BURN_ADDRESS()), 200 ether);
        assertEq(lpToken.balanceOf(address(token)), 300 ether);
    }

    function test_burnLP_revertsWhenDisabled() public {
        lpToken.mint(address(token), 500 ether);
        _setLPToken();

        address burnAdmin = address(0xB0);
        _setBurnAdmin(burnAdmin, true);

        // enableBurn() never called — burnEnabled defaults to false.
        vm.prank(burnAdmin);
        vm.expectRevert("burn disabled");
        token.burnLP(100 ether);
    }

    function test_burnLP_revertsForNonBurnAdmin() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not burn admin");
        token.burnLP(1 ether);
    }

    // ============ helpers ============

    function _signIntent(
        uint256 privKey,
        address from,
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes32 taskId
    ) internal view returns (bytes memory signature) {
        bytes32 structHash = keccak256(
            abi.encode(token.INTENT_TYPEHASH(), from, to, amount, nonce, deadline, taskId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _registerAgent(address a) internal {
        bytes32 salt = keccak256(abi.encode("REGISTER_AGENT", a));
        vm.prank(guardian1);
        token.approve(salt);
        vm.prank(guardian2);
        token.approve(salt);
        skip(2 days);
        token.registerAgent(a);
    }

    function _setLPToken() internal {
        bytes32 salt = keccak256(abi.encode("SET_LP_TOKEN", address(lpToken)));
        vm.prank(guardian1);
        token.approve(salt);
        vm.prank(guardian2);
        token.approve(salt);
        skip(2 days);
        token.setLPToken(address(lpToken));
    }

    function _setBurnAdmin(address admin, bool status) internal {
        bytes32 salt = keccak256(abi.encode("SET_BURN_ADMIN", admin, status));
        vm.prank(guardian1);
        token.approve(salt);
        vm.prank(guardian2);
        token.approve(salt);
        skip(2 days);
        token.setBurnAdmin(admin, status);
    }

    function _enableBurn() internal {
        bytes32 salt = keccak256(abi.encode("ENABLE_BURN"));
        vm.prank(guardian1);
        token.approve(salt);
        vm.prank(guardian2);
        token.approve(salt);
        skip(2 days);
        token.enableBurn();
    }

    function _prepareBurnAdmin() internal returns (address burnAdmin) {
        lpToken.mint(address(token), 500 ether);
        _setLPToken();

        burnAdmin = address(0xB0);
        _setBurnAdmin(burnAdmin, true);
        _enableBurn();
    }
}
