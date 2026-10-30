// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MuoCore} from "../contracts/MuoCore.sol";
import {MockMUSD} from "./MockMUSD.sol";
import {Vm} from "./Vm.sol";

/// @title MuoCoreTest
/// @notice Broad local regression suite for the deployed MuoCore source.
/// @dev Self-contained: no forge-std, no network, no fork. Assertions are plain
///      `require`-style reverts so the suite runs on a bare Foundry install.
///      Every test is deterministic (fixed private keys, explicit block numbers).
contract MuoCoreTest {
    /// @dev Canonical Foundry cheatcode address, declared locally so this file
    ///      does not depend on a cross-file constant import.
    address internal constant VM_ADDRESS = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;

    Vm internal constant vm = Vm(VM_ADDRESS);

    MuoCore internal core;
    MockMUSD internal musd;

    address internal owner;
    address internal alice;
    address internal bob;
    address internal carol;

    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;

    // Mirrors of the contract's error codes, so tests assert on the exact code.
    uint256 internal constant ERR_WINDOW_OPEN = 8400001;
    uint256 internal constant ERR_WINDOW_CLOSED = 8400002;
    uint256 internal constant ERR_INVALID_STATUS = 8400003;
    uint256 internal constant ERR_TRANSFER_FAILED = 8400004;
    uint256 internal constant ERR_ASSERTION_BOND_TOO_LOW = 8400100;
    uint256 internal constant ERR_ASSERTION_INVALID_LIVENESS = 8400101;
    uint256 internal constant ERR_ASSERTION_INVALID_IDENTIFIER = 8400102;
    uint256 internal constant ERR_NOT_CONTRACT_OWNER = 8403000;
    uint256 internal constant ERR_NOT_ARBITER = 8403200;
    uint256 internal constant ERR_ARBITER_CONFLICT = 8403300;
    uint256 internal constant ERR_SELF_DISPUTE = 8403400;
    uint256 internal constant ERR_ASSERTION_NOT_FOUND = 8404100;
    uint256 internal constant ERR_ARBITER_NOT_FOUND = 8404200;
    uint256 internal constant ERR_ASSERTION_ALREADY_EXISTS = 8409100;
    uint256 internal constant ERR_ARBITER_ALREADY_EXISTS = 8409200;
    uint256 internal constant ERR_SERIALIZATION_FAILED = 8500000;

    uint256 internal constant UNIT = 1e18;

    function setUp() public {
        owner = address(this);
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        carol = address(0xCA401);

        musd = new MockMUSD();
        core = new MuoCore(address(musd));

        // Fund the actors generously; tests assert on deltas, not absolutes.
        musd.mint(alice, 1_000_000 * UNIT);
        musd.mint(bob, 1_000_000 * UNIT);
        musd.mint(carol, 1_000_000 * UNIT);

        // Approvals are the ordinary path; permit is covered separately.
        vm.prank(alice);
        musd.approve(address(core), type(uint256).max);
        vm.prank(bob);
        musd.approve(address(core), type(uint256).max);
        vm.prank(carol);
        musd.approve(address(core), type(uint256).max);

        vm.roll(900_000);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _id(bytes32 identifier, bytes memory claim, uint256 bond, uint256 liveness, uint256 atBlock)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(identifier, claim, uint8(1), uint128(bond), uint8(1), uint128(liveness), uint8(1), uint128(atBlock)));
    }

    function _assertAs(address who, bytes32 identifier, bytes memory claim, uint256 bond, uint256 liveness)
        internal
        returns (bytes32)
    {
        vm.prank(who);
        return core.assertClaim(identifier, claim, bond, liveness);
    }

    function _disputeAs(address who, bytes32 id) internal {
        vm.prank(who);
        core.dispute(id);
    }

    function _resolveAs(address who, bytes32 id, uint8 status) internal {
        vm.prank(who);
        core.resolve(id, status);
    }

    function _expectRevertCode(uint256 code) internal {
        vm.expectRevert(abi.encodeWithSelector(MuoCore.MuoError.selector, code));
    }

    function _require(bool ok, string memory what) internal pure {
        require(ok, what);
    }

    // =====================================================================
    // 1. Assertion lifecycle: assert -> settle (permissionless)
    // =====================================================================

    function testAssertStoresRecordAndEscrowsBond() public {
        bytes32 identifier = bytes32(uint256(1));
        bytes memory claim = hex"deadbeef";
        uint256 bondBefore = musd.balanceOf(alice);

        bytes32 id = _assertAs(alice, identifier, claim, 10, 100);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.exists, "exists");
        _require(a.asserter == alice, "asserter");
        _require(a.disputer == address(0), "disputer zero");
        _require(a.bondMusd == 10, "bond");
        _require(a.liveness == 100, "liveness");
        _require(a.status == 0, "status open");
        _require(a.assertedAtBlock == 900_000, "assertedAtBlock");
        _require(a.disputedAtBlock == 0 && a.settledAtBlock == 0, "timestamps zero");

        _require(musd.balanceOf(alice) == bondBefore - 10 * UNIT, "alice debited");
        _require(musd.balanceOf(address(core)) == 10 * UNIT, "core escrow");
    }

    function testSettleIsPermissionlessAndReturnsBond() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(2)), hex"01", 10, 100);
        uint256 coreBefore = musd.balanceOf(address(core));
        uint256 aliceBefore = musd.balanceOf(alice);

        vm.roll(900_000 + 101);
        // carol is a disinterested third party.
        vm.prank(carol);
        core.settle(id);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 2, "settled");
        _require(a.settledAtBlock == 900_101, "settledAtBlock");
        _require(musd.balanceOf(alice) == aliceBefore + 10 * UNIT, "bond returned");
        _require(musd.balanceOf(address(core)) == coreBefore - 10 * UNIT, "escrow drained");
    }

    function testSettleRevertsWhileWindowOpen() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(3)), hex"01", 10, 100);
        vm.roll(900_000 + 100); // still inside: expiry == block.number
        _expectRevertCode(ERR_WINDOW_OPEN);
        core.settle(id);
    }

    function testSettleRevertsOnSecondCall() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(4)), hex"01", 10, 100);
        vm.roll(900_000 + 101);
        core.settle(id);
        _expectRevertCode(ERR_INVALID_STATUS);
        core.settle(id);
    }

    // =====================================================================
    // 2. Window boundary: dispute allowed exactly at expiry, settle only after
    // =====================================================================

    function testDisputeAllowedExactlyAtExpiry() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(5)), hex"01", 10, 100);
        vm.roll(900_000 + 100); // exactly expiryBlock
        _disputeAs(bob, id);
        _require(core.getAssertion(id).status == 1, "disputed at boundary");
    }

    function testDisputeRevertsOneBlockAfterExpiry() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(6)), hex"01", 10, 100);
        vm.roll(900_000 + 101);
        _expectRevertCode(ERR_WINDOW_CLOSED);
        vm.prank(bob);
        core.dispute(id);
    }

    function testWindowPredicatesAreComplements() public {
        uint256 expiry = 900_050;
        vm.roll(expiry);
        _require(core.isWindowOpen(expiry), "open at expiry");
        _require(!core.isWindowClosed(expiry), "not closed at expiry");
        vm.roll(expiry + 1);
        _require(!core.isWindowOpen(expiry), "not open after expiry");
        _require(core.isWindowClosed(expiry), "closed after expiry");
    }

    // =====================================================================
    // 3. Dispute rules
    // =====================================================================

    function testDisputePullsMatchingBondAndSetsState() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(7)), hex"01", 10, 100);
        uint256 bobBefore = musd.balanceOf(bob);
        uint256 coreBefore = musd.balanceOf(address(core));

        _disputeAs(bob, id);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 1, "disputed");
        _require(a.disputer == bob, "disputer");
        _require(a.disputedAtBlock == 900_000, "disputedAtBlock");
        _require(musd.balanceOf(bob) == bobBefore - 10 * UNIT, "bob debited");
        _require(musd.balanceOf(address(core)) == coreBefore + 10 * UNIT, "escrow 2x");
    }

    function testSelfDisputeReverts() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(8)), hex"01", 10, 100);
        _expectRevertCode(ERR_SELF_DISPUTE);
        vm.prank(alice);
        core.dispute(id);
    }

    function testDoubleDisputeReverts() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(9)), hex"01", 10, 100);
        _disputeAs(bob, id);
        _expectRevertCode(ERR_INVALID_STATUS);
        vm.prank(carol);
        core.dispute(id);
    }

    function testDisputeUnknownIdReverts() public {
        _expectRevertCode(ERR_ASSERTION_NOT_FOUND);
        vm.prank(bob);
        core.dispute(bytes32(uint256(0xdead)));
    }

    // =====================================================================
    // 4. Resolve: status 2 -> asserter 2x, 3 -> disputer 2x, 4 -> each 1x
    // =====================================================================

    function _setupDisputed(uint256 seed) internal returns (bytes32 id) {
        id = _assertAs(alice, bytes32(seed), hex"01", 10, 100);
        _disputeAs(bob, id);
    }

    function testResolveSettledPaysAsserterDoubleBond() public {
        bytes32 id = _setupDisputed(10);
        uint256 aliceBefore = musd.balanceOf(alice);
        uint256 bobBefore = musd.balanceOf(bob);

        _resolveAs(owner, id, 2);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 2, "settled");
        _require(a.settledAtBlock == 900_000, "settledAtBlock");
        _require(musd.balanceOf(alice) == aliceBefore + 20 * UNIT, "asserter +2x");
        _require(musd.balanceOf(bob) == bobBefore, "disputer unchanged");
        _require(musd.balanceOf(address(core)) == 0, "escrow empty");
    }

    function testResolveRejectedPaysDisputerDoubleBond() public {
        bytes32 id = _setupDisputed(11);
        uint256 aliceBefore = musd.balanceOf(alice);
        uint256 bobBefore = musd.balanceOf(bob);

        _resolveAs(owner, id, 3);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 3, "rejected");
        _require(a.rejectedAtBlock == 900_000, "rejectedAtBlock");
        _require(musd.balanceOf(bob) == bobBefore + 20 * UNIT, "disputer +2x");
        _require(musd.balanceOf(alice) == aliceBefore, "asserter unchanged");
        _require(musd.balanceOf(address(core)) == 0, "escrow empty");
    }

    function testResolveUnresolvedRefundsOneBondEach() public {
        bytes32 id = _setupDisputed(12);
        uint256 aliceBefore = musd.balanceOf(alice);
        uint256 bobBefore = musd.balanceOf(bob);

        _resolveAs(owner, id, 4);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 4, "unresolved");
        _require(a.unresolvedAtBlock == 900_000, "unresolvedAtBlock");
        _require(musd.balanceOf(alice) == aliceBefore + 10 * UNIT, "asserter +1x");
        _require(musd.balanceOf(bob) == bobBefore + 10 * UNIT, "disputer +1x");
        _require(musd.balanceOf(address(core)) == 0, "escrow empty");
    }

    function testResolveInvalidStatusCodesRevert() public {
        bytes32 id = _setupDisputed(13);
        for (uint8 bad = 0; bad <= 5; bad++) {
            if (bad == 2 || bad == 3 || bad == 4) continue;
            _expectRevertCode(ERR_INVALID_STATUS);
            vm.prank(owner);
            core.resolve(id, bad);
        }
    }

    function testResolveOnOpenAssertionReverts() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(14)), hex"01", 10, 100);
        _expectRevertCode(ERR_INVALID_STATUS);
        vm.prank(owner);
        core.resolve(id, 2);
    }

    function testResolveTwiceReverts() public {
        bytes32 id = _setupDisputed(15);
        _resolveAs(owner, id, 2);
        _expectRevertCode(ERR_INVALID_STATUS);
        vm.prank(owner);
        core.resolve(id, 2);
    }

    // =====================================================================
    // 5. Escrow conservation across every terminal path
    // =====================================================================

    function testEscrowConservationSettlePath() public {
        uint256 coreStart = musd.balanceOf(address(core));
        bytes32 id = _assertAs(alice, bytes32(uint256(20)), hex"01", 25, 100);
        vm.roll(900_000 + 101);
        core.settle(id);
        _require(musd.balanceOf(address(core)) == coreStart, "settle conserves escrow");
    }

    function testEscrowConservationResolvePaths() public {
        uint256 coreStart = musd.balanceOf(address(core));
        uint8[3] memory outcomes = [uint8(2), uint8(3), uint8(4)];
        for (uint256 i = 0; i < outcomes.length; i++) {
            bytes32 id = _assertAs(alice, bytes32(uint256(30 + i)), hex"01", 25, 100);
            _disputeAs(bob, id);
            _require(musd.balanceOf(address(core)) == coreStart + 50 * UNIT, "2x held while disputed");
            _resolveAs(owner, id, outcomes[i]);
            _require(musd.balanceOf(address(core)) == coreStart, "resolve conserves escrow");
        }
    }

    function testEscrowConservationSumOfPayoutsEqualsPool() public {
        bytes32 id = _setupDisputed(40);
        uint256 pool = musd.balanceOf(address(core));
        uint256 a0 = musd.balanceOf(alice);
        uint256 b0 = musd.balanceOf(bob);

        _resolveAs(owner, id, 4);

        uint256 paid = (musd.balanceOf(alice) - a0) + (musd.balanceOf(bob) - b0);
        _require(paid == pool, "payouts sum to pool");
    }

    // =====================================================================
    // 6. Roles, conflicts, immutable owner
    // =====================================================================

    function testDeployerIsOwnerAndArbiter() public {
        _require(core.CONTRACT_OWNER() == owner, "owner is deployer");
        _require(core.isArbiter(owner), "owner is arbiter");
    }

    function testOwnerIsImmutableInSource() public view {
        // CONTRACT_OWNER is `immutable`: it is a getter with no setter in the ABI.
        // This test documents the invariant; the absence of a setter is checked
        // by the ABI snapshot test in the TypeScript layer.
        _require(core.CONTRACT_OWNER() == owner, "owner unchanged");
    }

    function testAddArbiterOnlyOwner() public {
        _expectRevertCode(ERR_NOT_CONTRACT_OWNER);
        vm.prank(alice);
        core.addArbiter(carol);

        core.addArbiter(carol);
        _require(core.isArbiter(carol), "carol arbiter");
    }

    function testAddArbiterTwiceReverts() public {
        core.addArbiter(carol);
        _expectRevertCode(ERR_ARBITER_ALREADY_EXISTS);
        core.addArbiter(carol);
    }

    function testRemoveArbiterOnlyOwner() public {
        core.addArbiter(carol);
        _expectRevertCode(ERR_NOT_CONTRACT_OWNER);
        vm.prank(alice);
        core.removeArbiter(carol);
    }

    function testRemoveOwnerArbiterReverts() public {
        _expectRevertCode(ERR_ARBITER_CONFLICT);
        core.removeArbiter(owner);
    }

    function testRemoveUnknownArbiterReverts() public {
        _expectRevertCode(ERR_ARBITER_NOT_FOUND);
        core.removeArbiter(carol);
    }

    function testRemoveArbiterSucceedsThenCannotResolve() public {
        core.addArbiter(carol);
        core.removeArbiter(carol);
        _require(!core.isArbiter(carol), "carol removed");

        bytes32 id = _setupDisputed(50);
        _expectRevertCode(ERR_NOT_ARBITER);
        vm.prank(carol);
        core.resolve(id, 2);
    }

    function testNonArbiterCannotResolve() public {
        bytes32 id = _setupDisputed(51);
        _expectRevertCode(ERR_NOT_ARBITER);
        vm.prank(carol);
        core.resolve(id, 2);
    }

    function testArbiterCannotResolveOwnDispute() public {
        // alice is made an arbiter, then asserts and disputes her own claim.
        core.addArbiter(alice);
        bytes32 id = _assertAs(alice, bytes32(uint256(52)), hex"01", 10, 100);
        _disputeAs(bob, id);

        _expectRevertCode(ERR_ARBITER_CONFLICT);
        vm.prank(alice);
        core.resolve(id, 2);
    }

    function testArbiterCannotResolveWhenDisputer() public {
        core.addArbiter(bob);
        bytes32 id = _assertAs(alice, bytes32(uint256(53)), hex"01", 10, 100);
        _disputeAs(bob, id);

        _expectRevertCode(ERR_ARBITER_CONFLICT);
        vm.prank(bob);
        core.resolve(id, 2);
    }

    // =====================================================================
    // 7. Duplicate / missing IDs
    // =====================================================================

    function testDuplicateAssertionInSameBlockReverts() public {
        bytes32 identifier = bytes32(uint256(60));
        bytes memory claim = hex"abcd";
        _assertAs(alice, identifier, claim, 10, 100);

        _expectRevertCode(ERR_ASSERTION_ALREADY_EXISTS);
        vm.prank(bob);
        core.assertClaim(identifier, claim, 10, 100);
    }

    function testSameClaimDifferentBlockIsDistinct() public {
        bytes32 identifier = bytes32(uint256(61));
        bytes memory claim = hex"abcd";
        bytes32 first = _assertAs(alice, identifier, claim, 10, 100);
        vm.roll(900_001);
        bytes32 second = _assertAs(alice, identifier, claim, 10, 100);
        _require(first != second, "distinct ids across blocks");
    }

    function testSameClaimDifferentBondIsDistinct() public {
        bytes32 identifier = bytes32(uint256(62));
        bytes memory claim = hex"abcd";
        bytes32 first = _assertAs(alice, identifier, claim, 10, 100);
        bytes32 second = _assertAs(alice, identifier, claim, 11, 100);
        _require(first != second, "distinct ids across bonds");
    }

    function testUnknownAssertionLookupsAreEmpty() public view {
        MuoCore.Assertion memory a = core.getAssertion(bytes32(uint256(0xffff)));
        _require(!a.exists, "not exists");
        _require(a.asserter == address(0), "no asserter");
        _require(a.bondMusd == 0, "no bond");
    }

    // =====================================================================
    // 8. Token failure handling: false return and revert both roll back
    // =====================================================================

    function testPullBondFalseReturnRevertsAndRollsBack() public {
        musd.setForceReturnFalse(true);
        _expectRevertCode(ERR_TRANSFER_FAILED);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(70)), hex"01", 10, 100);

        // No state was written and no funds moved.
        _require(musd.balanceOf(address(core)) == 0, "no escrow");
    }

    function testPullBondRevertIsMappedAndRollsBack() public {
        musd.setForceRevert(true);
        _expectRevertCode(ERR_TRANSFER_FAILED);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(71)), hex"01", 10, 100);
        _require(musd.balanceOf(address(core)) == 0, "no escrow");
    }

    function testPushBondFalseReturnRevertsAndKeepsEscrow() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(72)), hex"01", 10, 100);
        vm.roll(900_000 + 101);
        musd.setForceReturnFalse(true);

        _expectRevertCode(ERR_TRANSFER_FAILED);
        core.settle(id);

        // Status must not have advanced, and the escrow must still hold the bond.
        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 0, "still open");
        _require(musd.balanceOf(address(core)) == 10 * UNIT, "escrow intact");
    }

    function testInsufficientAllowanceRevertsAndRollsBack() public {
        vm.prank(carol);
        musd.approve(address(core), 0);
        _expectRevertCode(ERR_TRANSFER_FAILED);
        vm.prank(carol);
        core.assertClaim(bytes32(uint256(73)), hex"01", 10, 100);
    }

    function testDisputeWithInsufficientBalanceReverts() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(74)), hex"01", 1000, 100);
        // Drain bob so his matching bond cannot be pulled. The balance must be
        // read BEFORE the prank, otherwise the balanceOf call itself would
        // consume the pending prank.
        uint256 bobBalance = musd.balanceOf(bob);
        vm.prank(bob);
        musd.transfer(carol, bobBalance);

        _expectRevertCode(ERR_TRANSFER_FAILED);
        vm.prank(bob);
        core.dispute(id);
        _require(core.getAssertion(id).status == 0, "still open");
    }

    // =====================================================================
    // 9. Liveness: default 0 -> 1440, bounds 1..52560
    // =====================================================================

    function testZeroLivenessDefaultsTo1440() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(80)), hex"01", 10, 0);
        _require(core.getAssertion(id).liveness == 1440, "default liveness");
        _require(core.getDefaultLiveness() == 1440, "getter");
    }

    function testLivenessLowerBoundAccepted() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(81)), hex"01", 10, 1);
        _require(core.getAssertion(id).liveness == 1, "liveness 1");
    }

    function testLivenessUpperBoundAccepted() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(82)), hex"01", 10, 52560);
        _require(core.getAssertion(id).liveness == 52560, "liveness max");
    }

    function testLivenessAboveMaxReverts() public {
        _expectRevertCode(ERR_ASSERTION_INVALID_LIVENESS);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(83)), hex"01", 10, 52561);
    }

    function testLivenessConstantsExposed() public view {
        _require(core.MIN_LIVENESS() == 1, "min");
        _require(core.MAX_LIVENESS() == 52560, "max");
        _require(core.DEFAULT_LIVENESS() == 1440, "default");
    }

    // =====================================================================
    // 10. Claim length: 1..2048 accepted, 0 and 2049 rejected
    // =====================================================================

    function testClaimOneByteAccepted() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(90)), hex"01", 10, 100);
        _require(core.getAssertion(id).exists, "1 byte ok");
    }

    function testClaim2048BytesAccepted() public {
        bytes memory claim = new bytes(2048);
        for (uint256 i = 0; i < 2048; i++) {
            claim[i] = bytes1(uint8(i % 251));
        }
        bytes32 id = _assertAs(alice, bytes32(uint256(91)), claim, 10, 100);
        _require(core.getAssertion(id).exists, "2048 bytes ok");
    }

    function testClaimZeroBytesReverts() public {
        _expectRevertCode(ERR_ASSERTION_INVALID_IDENTIFIER);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(92)), hex"", 10, 100);
    }

    function testClaim2049BytesReverts() public {
        bytes memory claim = new bytes(2049);
        _expectRevertCode(ERR_ASSERTION_INVALID_IDENTIFIER);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(93)), claim, 10, 100);
    }

    function testClaimLengthConstantExposed() public view {
        _require(core.MAX_CLAIM_LENGTH() == 2048, "max claim");
    }

    // =====================================================================
    // 11. Bond floor and uint128 deriveAssertionId bound
    // =====================================================================

    function testBondBelowFloorReverts() public {
        _expectRevertCode(ERR_ASSERTION_BOND_TOO_LOW);
        vm.prank(alice);
        core.assertClaim(bytes32(uint256(100)), hex"01", 9, 100);
    }

    function testBondAtFloorAccepted() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(101)), hex"01", 10, 100);
        _require(core.getAssertion(id).bondMusd == 10, "floor accepted");
    }

    function testBondFloorsExposed() public view {
        _require(core.getMinBondMusd() == 10, "min bond musd");
        // Compatibility getter retained from the deployed ABI.
        _require(core.getMinBondSats() == 10000, "min bond sats retained");
        _require(core.MIN_BOND_MUSD() == 10, "MIN_BOND_MUSD");
        _require(core.MIN_BOND_SATS() == 10000, "MIN_BOND_SATS");
    }

    function testDeriveAssertionIdRejectsBondAboveUint128() public {
        uint256 tooBig = uint256(type(uint128).max) + 1;
        (bool ok, bytes memory data) = address(core).staticcall(
            abi.encodeWithSelector(MuoCore.deriveAssertionId.selector, bytes32(uint256(1)), hex"01", tooBig, 1440, 900_000)
        );
        _require(!ok, "must revert");
        _require(keccak256(data) == keccak256(abi.encodeWithSelector(MuoCore.MuoError.selector, ERR_SERIALIZATION_FAILED)), "code");
    }

    function testDeriveAssertionIdAcceptsUint128Max() public view {
        uint256 max = uint256(type(uint128).max);
        bytes32 id = core.deriveAssertionId(bytes32(uint256(1)), hex"01", max, 1440, 900_000);
        _require(id != bytes32(0), "computed");
    }

    function testDeriveAssertionIdRejectsLivenessAboveUint128() public {
        uint256 tooBig = uint256(type(uint128).max) + 1;
        (bool ok,) = address(core).staticcall(
            abi.encodeWithSelector(MuoCore.deriveAssertionId.selector, bytes32(uint256(1)), hex"01", 10, tooBig, 900_000)
        );
        _require(!ok, "must revert");
    }

    function testDeriveAssertionIdRejectsBlockAboveUint128() public {
        uint256 tooBig = uint256(type(uint128).max) + 1;
        (bool ok,) = address(core).staticcall(
            abi.encodeWithSelector(MuoCore.deriveAssertionId.selector, bytes32(uint256(1)), hex"01", 10, 1440, tooBig)
        );
        _require(!ok, "must revert");
    }

    // =====================================================================
    // 12. Golden digest: sha256, big-endian uint128, NOT keccak256
    // =====================================================================

    /// @dev identifier = 0xbb repeated 32 times, assembled by shifting so the
    ///      width is guaranteed rather than depending on a hand-counted literal.
    function _goldenIdentifier() internal pure returns (bytes32) {
        uint256 acc;
        for (uint256 i = 0; i < 32; i++) {
            acc = (acc << 8) | 0xbb;
        }
        return bytes32(acc);
    }

    /// @dev claim = "cc" repeated 64 times, i.e. 128 hex characters = 64 bytes.
    ///      Note this is 64 BYTES, not 64 hex chars (which would be 32 bytes).
    function _goldenClaim() internal pure returns (bytes memory) {
        bytes memory claim = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            claim[i] = bytes1(uint8(0xcc));
        }
        return claim;
    }

    /// @dev Pinned vector shared with the TypeScript helper:
    ///      identifier bb*32, claim cc*64, bond 10000, liveness 1440, block 900000.
    function testGoldenAssertionIdMatchesPinnedDigest() public view {
        bytes32 identifier = _goldenIdentifier();
        bytes memory claim = _goldenClaim();

        bytes32 expected = 0xc7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5;
        bytes32 actual = core.deriveAssertionId(identifier, claim, 10000, 1440, 900_000);
        _require(actual == expected, "golden digest mismatch");

        // And the local reimplementation must agree with the contract.
        _require(_id(identifier, claim, 10000, 1440, 900_000) == expected, "local helper mismatch");
    }

    /// @dev Proves the digest is SHA-256 over the Clarity layout, not keccak256.
    function testGoldenDigestIsSha256NotKeccak() public pure {
        bytes32 identifier = _goldenIdentifier();
        bytes memory claim = _goldenClaim();
        bytes memory preimage =
            abi.encodePacked(identifier, claim, uint8(1), uint128(10000), uint8(1), uint128(1440), uint8(1), uint128(900_000));
        bytes32 sha = sha256(preimage);
        bytes32 kec = keccak256(preimage);
        _require(sha != kec, "sha256 and keccak differ");
        _require(sha == 0xc7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5, "sha256 pinned");
    }

    function testGoldenPreimageLayoutIsBigEndian() public pure {
        // uint128(10000) must be 15 zero bytes then 0x2710 (big-endian).
        bytes memory encoded = abi.encodePacked(uint128(10000));
        _require(encoded.length == 16, "16 bytes");
        _require(uint8(encoded[14]) == 0x27 && uint8(encoded[15]) == 0x10, "big-endian tail");
        for (uint256 i = 0; i < 14; i++) {
            _require(uint8(encoded[i]) == 0x00, "leading zeros");
        }
    }

    function testDeriveAssertionIdIsDeterministicAndSensitive() public view {
        bytes32 identifier = bytes32(uint256(0xaa));
        bytes memory claim = hex"0102";
        bytes32 base = core.deriveAssertionId(identifier, claim, 10, 1440, 900_000);
        _require(base == core.deriveAssertionId(identifier, claim, 10, 1440, 900_000), "deterministic");
        _require(base != core.deriveAssertionId(identifier, claim, 11, 1440, 900_000), "bond sensitive");
        _require(base != core.deriveAssertionId(identifier, claim, 10, 1441, 900_000), "liveness sensitive");
        _require(base != core.deriveAssertionId(identifier, claim, 10, 1440, 900_001), "block sensitive");
        _require(base != core.deriveAssertionId(bytes32(uint256(0xab)), claim, 10, 1440, 900_000), "identifier sensitive");
        _require(base != core.deriveAssertionId(identifier, hex"0103", 10, 1440, 900_000), "claim sensitive");
    }

    // =====================================================================
    // 13. Permit paths
    // =====================================================================

    function _permitSig(address who, uint256 pk, uint256 value, uint256 deadline)
        internal
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(musd.PERMIT_TYPEHASH(), who, address(core), value, musd.nonces(who), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(pk, digest);
    }

    function testAssertWithPermitSucceeds() public {
        // Fresh actor with no prior approval.
        uint256 pk = 0xC0FFEE;
        address dave = vm.addr(pk);
        musd.mint(dave, 1000 * UNIT);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(dave, pk, 10 * UNIT, deadline);

        vm.prank(dave);
        bytes32 id = core.assertWithPermit(bytes32(uint256(110)), hex"01", 10, 100, deadline, v, r, s);

        _require(core.getAssertion(id).exists, "asserted via permit");
        _require(musd.balanceOf(address(core)) == 10 * UNIT, "bond escrowed");
        _require(musd.nonces(dave) == 1, "nonce consumed");
    }

    function testAssertWithPermitExpiredDeadlineReverts() public {
        uint256 pk = 0xC0FFEE;
        address dave = vm.addr(pk);
        musd.mint(dave, 1000 * UNIT);

        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(dave, pk, 10 * UNIT, deadline);

        vm.expectRevert();
        vm.prank(dave);
        core.assertWithPermit(bytes32(uint256(111)), hex"01", 10, 100, deadline, v, r, s);
    }

    function testAssertWithPermitReplayedNonceReverts() public {
        uint256 pk = 0xC0FFEE;
        address dave = vm.addr(pk);
        musd.mint(dave, 1000 * UNIT);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(dave, pk, 10 * UNIT, deadline);

        vm.prank(dave);
        core.assertWithPermit(bytes32(uint256(112)), hex"01", 10, 100, deadline, v, r, s);

        // Replaying the same signature must fail: the nonce advanced.
        vm.expectRevert();
        vm.prank(dave);
        core.assertWithPermit(bytes32(uint256(113)), hex"01", 10, 100, deadline, v, r, s);
    }

    function testDisputeWithPermitSucceeds() public {
        bytes32 id = _assertAs(alice, bytes32(uint256(114)), hex"01", 10, 100);

        uint256 pk = 0xBEEF;
        address erin = vm.addr(pk);
        musd.mint(erin, 1000 * UNIT);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(erin, pk, 10 * UNIT, deadline);

        vm.prank(erin);
        core.disputeWithPermit(id, deadline, v, r, s);

        MuoCore.Assertion memory a = core.getAssertion(id);
        _require(a.status == 1, "disputed");
        _require(a.disputer == erin, "disputer erin");
    }

    function testDisputeWithPermitUnknownIdReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        _expectRevertCode(ERR_ASSERTION_NOT_FOUND);
        vm.prank(alice);
        core.disputeWithPermit(bytes32(uint256(0xdead)), deadline, 0, bytes32(0), bytes32(0));
    }

    function testPermitDoesNotSurviveFailedAssert() public {
        // A revert in assertClaim must unwind the permit, leaving no allowance.
        uint256 pk = 0xC0FFEE;
        address dave = vm.addr(pk);
        musd.mint(dave, 1000 * UNIT);

        // The contract sizes the permit from bondMusd, so the signature must be
        // for exactly the same value the contract will request: 9 * UNIT here.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(dave, pk, 9 * UNIT, deadline);

        // bond 9 is below the floor, so assertClaim reverts after the permit.
        _expectRevertCode(ERR_ASSERTION_BOND_TOO_LOW);
        vm.prank(dave);
        core.assertWithPermit(bytes32(uint256(115)), hex"01", 9, 100, deadline, v, r, s);

        _require(musd.allowance(dave, address(core)) == 0, "allowance rolled back");
    }

    // =====================================================================
    // 14. Constants / ABI surface retained for compatibility
    // =====================================================================

    function testStatusConstantsMatchOffChainTable() public view {
        _require(core.STATUS_OPEN() == 0, "open");
        _require(core.STATUS_DISPUTED() == 1, "disputed");
        _require(core.STATUS_SETTLED() == 2, "settled");
        _require(core.STATUS_REJECTED() == 3, "rejected");
        _require(core.STATUS_UNRESOLVED() == 4, "unresolved");
    }

    function testErrorConstantsMatchOffChainTable() public view {
        _require(core.ERR_WINDOW_OPEN() == 8400001, "e1");
        _require(core.ERR_WINDOW_CLOSED() == 8400002, "e2");
        _require(core.ERR_INVALID_STATUS() == 8400003, "e3");
        _require(core.ERR_TRANSFER_FAILED() == 8400004, "e4");
        _require(core.ERR_SERIALIZATION_FAILED() == 8500000, "e5");
    }

    function testMezoAddressConstants() public view {
        _require(core.MUSD_MAINNET() == 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186, "mainnet musd");
        _require(core.MUSD_TESTNET() == 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503, "testnet musd");
        _require(core.SKIP_ORACLE_PRECOMPILE() == 0x7b7c000000000000000000000000000000000015, "oracle");
    }

    function testMusdUnitAndPermitName() public view {
        _require(core.MUSD_UNIT() == 1e18, "unit");
        _require(keccak256(bytes(core.MUSD_PERMIT_NAME())) == keccak256(bytes("Mezo USD")), "permit name");
    }

    function testConstructorBindsProvidedMusd() public view {
        _require(address(core.musd()) == address(musd), "musd bound");
    }

    function testConstructorZeroAddressSelectsTestnetMusd() public {
        MuoCore fresh = new MuoCore(address(0));
        _require(address(fresh.musd()) == 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503, "testnet default");
    }

    // =====================================================================
    // 15. Fuzz-style sweep over bond and liveness without fuzzing engine
    // =====================================================================

    function testBondSweepAboveFloorAlwaysEscrowsExactAmount() public {
        uint256[5] memory bonds = [uint256(10), 11, 100, 1000, 12345];
        for (uint256 i = 0; i < bonds.length; i++) {
            uint256 before = musd.balanceOf(address(core));
            bytes32 id = _assertAs(alice, bytes32(uint256(200 + i)), hex"01", bonds[i], 100);
            _require(musd.balanceOf(address(core)) == before + bonds[i] * UNIT, "exact escrow");
            _require(core.getAssertion(id).bondMusd == bonds[i], "stored bond");
        }
    }

    function testLivenessSweepWithinBounds() public {
        uint256[4] memory lives = [uint256(1), 2, 1440, 52560];
        for (uint256 i = 0; i < lives.length; i++) {
            bytes32 id = _assertAs(alice, bytes32(uint256(300 + i)), hex"01", 10, lives[i]);
            _require(core.getAssertion(id).liveness == lives[i], "stored liveness");
        }
    }
}
