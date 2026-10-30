// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMUSD
/// @notice Minimal Mezo USD (MUSD) surface used by {MuoCore}.
/// @dev MUSD is an 18-decimal ERC-20 exposing EIP-2612 `permit` under the
///      domain name "Mezo USD", which enables the single-transaction fast paths.
interface IMUSD {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @title ISkipOracle
/// @notice Mezo Skip Connect oracle precompile surface (Chainlink-compatible aggregator).
/// @dev Reached at {MuoCore.SKIP_ORACLE_PRECOMPILE}, Mezo's consensus-level BTC/USD feed.
interface ISkipOracle {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title MuoCore
/// @notice Mezo Upbeat Oracle — trustless assertion layer ported to Mezo.
/// @dev Optimistic assertion layer: MUSD bonds, a liveness window, disputes and arbiter resolution.
///      Bonds are denominated in MUSD on Mezo (18 decimals) instead of sBTC satoshis;
///      `MIN_BOND_SATS` is retained so the cross-chain bond floor stays comparable.
///      Assertion IDs use a fixed consensus encoding so a digest produced here is
///      byte-for-byte identical to the `muo/utils` `computeAssertionId` helper.
contract MuoCore {
    // ---------------------------------------------------------------------
    // Mezo protocol addresses
    // ---------------------------------------------------------------------

    /// @notice Canonical MUSD on Mezo mainnet.
    address public constant MUSD_MAINNET = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    /// @notice Canonical MUSD on Mezo testnet (default when the constructor gets address(0)).
    address public constant MUSD_TESTNET = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    /// @notice Mezo BTC precompile.
    address public constant BTC_PRECOMPILE = 0x7b7C000000000000000000000000000000000000;
    /// @notice Mezo core precompile.
    address public constant MEZO_PRECOMPILE = 0x7B7c000000000000000000000000000000000001;
    /// @notice Mezo Skip oracle precompile.
    address public constant SKIP_ORACLE_PRECOMPILE = 0x7b7c000000000000000000000000000000000015;

    // ---------------------------------------------------------------------
    // Protocol constants
    // ---------------------------------------------------------------------

    uint256 public constant DEFAULT_LIVENESS = 1440;
    uint256 public constant MIN_LIVENESS = 1;
    uint256 public constant MAX_LIVENESS = 52560;
    uint256 public constant MIN_BOND_MUSD = 10;
    uint256 public constant MIN_BOND_SATS = 10000;

    uint8 public constant STATUS_OPEN = 0;
    uint8 public constant STATUS_DISPUTED = 1;
    uint8 public constant STATUS_SETTLED = 2;
    uint8 public constant STATUS_REJECTED = 3;
    uint8 public constant STATUS_UNRESOLVED = 4;

    // ---------------------------------------------------------------------
    // Error codes
    // ---------------------------------------------------------------------

    uint256 public constant ERR_WINDOW_OPEN = 8400001;
    uint256 public constant ERR_WINDOW_CLOSED = 8400002;
    uint256 public constant ERR_INVALID_STATUS = 8400003;
    uint256 public constant ERR_TRANSFER_FAILED = 8400004;
    uint256 public constant ERR_ASSERTION_BOND_TOO_LOW = 8400100;
    uint256 public constant ERR_ASSERTION_INVALID_LIVENESS = 8400101;
    uint256 public constant ERR_ASSERTION_INVALID_IDENTIFIER = 8400102;
    uint256 public constant ERR_NOT_CONTRACT_OWNER = 8403000;
    uint256 public constant ERR_NOT_ARBITER = 8403200;
    uint256 public constant ERR_ARBITER_CONFLICT = 8403300;
    uint256 public constant ERR_SELF_DISPUTE = 8403400;
    uint256 public constant ERR_ASSERTION_NOT_FOUND = 8404100;
    uint256 public constant ERR_ARBITER_NOT_FOUND = 8404200;
    uint256 public constant ERR_ASSERTION_ALREADY_EXISTS = 8409100;
    uint256 public constant ERR_ARBITER_ALREADY_EXISTS = 8409200;
    uint256 public constant ERR_SERIALIZATION_FAILED = 8500000;

    /// @notice Reverts with a typed {MuoError} code.
    error MuoError(uint256 code);

    // ---------------------------------------------------------------------
    // MUSD / permit constants
    // ---------------------------------------------------------------------

    /// @notice MUSD base unit, 1 MUSD = 1e18 wei.
    uint256 public constant MUSD_UNIT = 1e18;
    /// @notice EIP-2612 domain name of the MUSD token, `ERC20Permit("Mezo USD")`.
    string public constant MUSD_PERMIT_NAME = "Mezo USD";
    /// @notice Maximum claim payload, capped at 2048 bytes.
    uint256 public constant MAX_CLAIM_LENGTH = 2048;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Assertion {
        address asserter;
        address disputer;
        uint256 bondMusd;
        uint256 liveness;
        uint8 status;
        uint256 assertedAtBlock;
        uint256 disputedAtBlock;
        uint256 settledAtBlock;
        uint256 rejectedAtBlock;
        uint256 unresolvedAtBlock;
        bool exists;
    }

    /// @notice Deployer, the contract owner (the account that deployed the contract).
    address public immutable CONTRACT_OWNER;

    /// @notice MUSD token used for bonds.
    IMUSD public immutable musd;

    /// @notice assertion-id => assertion record.
    mapping(bytes32 => Assertion) public assertionMap;

    /// @notice account => arbiter flag.
    mapping(address => bool) public arbiterMap;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ArbiterAdded(address indexed account);
    event ArbiterRemoved(address indexed account);
    event Asserted(
        bytes32 indexed assertionId,
        address indexed assertedBy,
        bytes32 identifier,
        bytes claim,
        uint256 bondMusd,
        uint256 liveness,
        uint256 assertedAtBlock
    );
    event Disputed(bytes32 indexed assertionId, address indexed disputedBy, uint256 disputedAtBlock);
    event Settled(bytes32 indexed assertionId, address indexed settledBy, uint256 settledAtBlock);
    event Rejected(bytes32 indexed assertionId, address indexed rejectedBy, uint256 rejectedAtBlock);
    event Unresolved(bytes32 indexed assertionId, address indexed unresolvedBy, uint256 unresolvedAtBlock);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param _musd MUSD token address; `address(0)` selects {MUSD_TESTNET}.
    constructor(address _musd) {
        CONTRACT_OWNER = msg.sender;
        musd = IMUSD(_musd == address(0) ? MUSD_TESTNET : _musd);
        arbiterMap[msg.sender] = true;
    }

    // ---------------------------------------------------------------------
    // Read-only functions
    // ---------------------------------------------------------------------

    /// @notice Derives the assertion id.
    /// @dev Packs `identifier || claim || 0x01 || uint128(bondMusd) || 0x01 || uint128(liveness) || 0x01 || uint128(assertedAtBlock)`,
    ///      which is the consensus serialisation of three `uint` values appended to two buffers.
    ///      The result is the raw 32-byte SHA-256 digest, so it matches the `muo/utils` `computeAssertionId` helper.
    function deriveAssertionId(
        bytes32 identifier,
        bytes calldata claim,
        uint256 bondMusd,
        uint256 liveness,
        uint256 assertedAtBlock
    ) public pure returns (bytes32) {
        _requireU128(bondMusd);
        _requireU128(liveness);
        _requireU128(assertedAtBlock);

        return sha256(
            abi.encodePacked(
                identifier,
                claim,
                uint8(1),
                uint128(bondMusd),
                uint8(1),
                uint128(liveness),
                uint8(1),
                uint128(assertedAtBlock)
            )
        );
    }

    function getDefaultLiveness() external pure returns (uint256) {
        return DEFAULT_LIVENESS;
    }

    function getMinBondMusd() external pure returns (uint256) {
        return MIN_BOND_MUSD;
    }

    function getMinBondSats() external pure returns (uint256) {
        return MIN_BOND_SATS;
    }

    /// @notice Reads Mezo's consensus-level Skip Connect BTC/USD oracle precompile.
    /// @dev Returns the raw feed values: `answer` is scaled by the feed's own `decimals()`
    ///      (18 on Mezo testnet), and `updatedAt` is the publish timestamp. Callers scale as needed.
    function getBtcPrice() external view returns (int256 answer, uint256 updatedAt) {
        (, answer, , updatedAt, ) = ISkipOracle(SKIP_ORACLE_PRECOMPILE).latestRoundData();
    }

    function getAssertion(bytes32 assertionId) external view returns (Assertion memory) {
        return assertionMap[assertionId];
    }

    /// @notice The window is open while `expiryBlock >= block.number`.
    function isWindowOpen(uint256 expiryBlock) public view returns (bool) {
        return expiryBlock >= block.number;
    }

    /// @notice The window is closed once `block.number > expiryBlock`.
    function isWindowClosed(uint256 expiryBlock) public view returns (bool) {
        return block.number > expiryBlock;
    }

    function isArbiter(address account) external view returns (bool) {
        return arbiterMap[account];
    }

    // ---------------------------------------------------------------------
    // Arbiter administration
    // ---------------------------------------------------------------------

    function addArbiter(address account) external returns (bool) {
        if (msg.sender != CONTRACT_OWNER) revert MuoError(ERR_NOT_CONTRACT_OWNER);
        if (arbiterMap[account]) revert MuoError(ERR_ARBITER_ALREADY_EXISTS);

        arbiterMap[account] = true;
        emit ArbiterAdded(account);
        return true;
    }

    function removeArbiter(address account) external returns (bool) {
        if (msg.sender != CONTRACT_OWNER) revert MuoError(ERR_NOT_CONTRACT_OWNER);
        if (account == CONTRACT_OWNER) revert MuoError(ERR_ARBITER_CONFLICT);
        if (!arbiterMap[account]) revert MuoError(ERR_ARBITER_NOT_FOUND);

        delete arbiterMap[account];
        emit ArbiterRemoved(account);
        return true;
    }

    // ---------------------------------------------------------------------
    // Assertions
    // ---------------------------------------------------------------------

    /// @notice Asserts a claim.
    /// @param identifier 32-byte identifier; always 32 bytes in the ABI, matching `(buff 32)`.
    /// @param claim Non-empty payload of at most {MAX_CLAIM_LENGTH} bytes.
    /// @param bondMusd Bond in whole MUSD, must be at least {MIN_BOND_MUSD}.
    /// @param liveness Window length in blocks; `0` defaults to {DEFAULT_LIVENESS}.
    function assertClaim(bytes32 identifier, bytes calldata claim, uint256 bondMusd, uint256 liveness) public returns (bytes32) {
        uint256 resolvedLiveness = liveness == 0 ? DEFAULT_LIVENESS : liveness;

        if (claim.length == 0 || claim.length > MAX_CLAIM_LENGTH) revert MuoError(ERR_ASSERTION_INVALID_IDENTIFIER);
        if (resolvedLiveness < MIN_LIVENESS || resolvedLiveness > MAX_LIVENESS) revert MuoError(ERR_ASSERTION_INVALID_LIVENESS);
        if (bondMusd < MIN_BOND_MUSD) revert MuoError(ERR_ASSERTION_BOND_TOO_LOW);

        uint256 assertedAtBlock = block.number;
        bytes32 assertionId = deriveAssertionId(identifier, claim, bondMusd, resolvedLiveness, assertedAtBlock);

        if (assertionMap[assertionId].exists) revert MuoError(ERR_ASSERTION_ALREADY_EXISTS);

        _pullBond(msg.sender, bondMusd);

        assertionMap[assertionId] = Assertion({
            asserter: msg.sender,
            disputer: address(0),
            bondMusd: bondMusd,
            liveness: resolvedLiveness,
            status: STATUS_OPEN,
            assertedAtBlock: assertedAtBlock,
            disputedAtBlock: 0,
            settledAtBlock: 0,
            rejectedAtBlock: 0,
            unresolvedAtBlock: 0,
            exists: true
        });

        emit Asserted(assertionId, msg.sender, identifier, claim, bondMusd, resolvedLiveness, assertedAtBlock);
        return assertionId;
    }

    /// @notice Single-transaction assert: EIP-2612 `permit` on MUSD followed by {assertClaim}.
    /// @dev Reverts propagate from `permit`; a rejected `assertClaim` rolls the permit back with it.
    function assertWithPermit(
        bytes32 identifier,
        bytes calldata claim,
        uint256 bondMusd,
        uint256 liveness,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32) {
        musd.permit(msg.sender, address(this), bondMusd * MUSD_UNIT, deadline, v, r, s);
        return assertClaim(identifier, claim, bondMusd, liveness);
    }

    /// @notice Disputes an assertion.
    function dispute(bytes32 assertionId) public returns (bool) {
        Assertion storage assertion = assertionMap[assertionId];

        if (!assertion.exists) revert MuoError(ERR_ASSERTION_NOT_FOUND);
        if (assertion.status != STATUS_OPEN) revert MuoError(ERR_INVALID_STATUS);
        if (msg.sender == assertion.asserter) revert MuoError(ERR_SELF_DISPUTE);
        if (isWindowClosed(assertion.assertedAtBlock + assertion.liveness)) revert MuoError(ERR_WINDOW_CLOSED);

        _pullBond(msg.sender, assertion.bondMusd);

        assertion.disputer = msg.sender;
        assertion.status = STATUS_DISPUTED;
        assertion.disputedAtBlock = block.number;

        emit Disputed(assertionId, msg.sender, block.number);
        return true;
    }

    /// @notice Single-transaction dispute: EIP-2612 `permit` on MUSD followed by {dispute}.
    function disputeWithPermit(bytes32 assertionId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external returns (bool) {
        Assertion storage assertion = assertionMap[assertionId];
        if (!assertion.exists) revert MuoError(ERR_ASSERTION_NOT_FOUND);

        musd.permit(msg.sender, address(this), assertion.bondMusd * MUSD_UNIT, deadline, v, r, s);
        return dispute(assertionId);
    }

    /// @notice Settles an uncontested assertion.
    function settle(bytes32 assertionId) external returns (bool) {
        Assertion storage assertion = assertionMap[assertionId];

        if (!assertion.exists) revert MuoError(ERR_ASSERTION_NOT_FOUND);
        if (assertion.status != STATUS_OPEN) revert MuoError(ERR_INVALID_STATUS);
        if (!isWindowClosed(assertion.assertedAtBlock + assertion.liveness)) revert MuoError(ERR_WINDOW_OPEN);

        assertion.status = STATUS_SETTLED;
        assertion.settledAtBlock = block.number;

        _pushBond(assertion.asserter, assertion.bondMusd);

        emit Settled(assertionId, msg.sender, block.number);
        return true;
    }

    /// @notice Resolves a disputed assertion.
    /// @param resolveStatus {STATUS_SETTLED} pays 2x bond to the asserter, {STATUS_REJECTED} pays 2x bond
    ///        to the disputer, {STATUS_UNRESOLVED} refunds one bond to each party; anything else reverts.
    function resolve(bytes32 assertionId, uint8 resolveStatus) external returns (bool) {
        Assertion storage assertion = assertionMap[assertionId];

        if (!assertion.exists) revert MuoError(ERR_ASSERTION_NOT_FOUND);
        if (assertion.disputer == address(0)) revert MuoError(ERR_INVALID_STATUS);
        if (!arbiterMap[msg.sender]) revert MuoError(ERR_NOT_ARBITER);
        if (assertion.status != STATUS_DISPUTED) revert MuoError(ERR_INVALID_STATUS);
        if (msg.sender == assertion.asserter || msg.sender == assertion.disputer) revert MuoError(ERR_ARBITER_CONFLICT);

        uint256 bondMusd = assertion.bondMusd;

        if (resolveStatus == STATUS_SETTLED) {
            assertion.status = STATUS_SETTLED;
            assertion.settledAtBlock = block.number;
            _pushBond(assertion.asserter, bondMusd * 2);
            emit Settled(assertionId, msg.sender, block.number);
            return true;
        }

        if (resolveStatus == STATUS_REJECTED) {
            assertion.status = STATUS_REJECTED;
            assertion.rejectedAtBlock = block.number;
            _pushBond(assertion.disputer, bondMusd * 2);
            emit Rejected(assertionId, msg.sender, block.number);
            return true;
        }

        if (resolveStatus != STATUS_UNRESOLVED) revert MuoError(ERR_INVALID_STATUS);

        assertion.status = STATUS_UNRESOLVED;
        assertion.unresolvedAtBlock = block.number;
        _pushBond(assertion.asserter, bondMusd);
        _pushBond(assertion.disputer, bondMusd);
        emit Unresolved(assertionId, msg.sender, block.number);
        return true;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Consensus encoding of a `uint` only succeeds up to `u128`.
    function _requireU128(uint256 value) private pure {
        if (value > type(uint128).max) revert MuoError(ERR_SERIALIZATION_FAILED);
    }

    /// @dev Pulls the bond into the contract, mapping any failure to {ERR_TRANSFER_FAILED}.
    function _pullBond(address from, uint256 bondMusd) private {
        try musd.transferFrom(from, address(this), bondMusd * MUSD_UNIT) returns (bool ok) {
            if (!ok) revert MuoError(ERR_TRANSFER_FAILED);
        } catch {
            revert MuoError(ERR_TRANSFER_FAILED);
        }
    }

    /// @dev Pushes the bond out, mapping any failure to {ERR_TRANSFER_FAILED}.
    function _pushBond(address to, uint256 bondMusd) private {
        try musd.transfer(to, bondMusd * MUSD_UNIT) returns (bool ok) {
            if (!ok) revert MuoError(ERR_TRANSFER_FAILED);
        } catch {
            revert MuoError(ERR_TRANSFER_FAILED);
        }
    }
}
