// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Vm
/// @notice Minimal, hand-rolled subset of the Foundry cheatcode interface.
/// @dev Deliberately self-contained: the test suite must not depend on forge-std,
///      a network fetch, or any vendored library. Only the cheatcodes actually
///      used by the MuoCore regression suite are declared, so this file stays
///      auditable in isolation.
interface Vm {
    /// @dev Sets `msg.sender` for the next external call only.
    function prank(address msgSender) external;

    /// @dev Sets `msg.sender` for all subsequent calls until {stopPrank}.
    function startPrank(address msgSender) external;

    /// @dev Ends a {startPrank} session.
    function stopPrank() external;

    /// @dev Sets `block.number` for subsequent calls.
    function roll(uint256 newHeight) external;

    /// @dev Sets `block.timestamp` for subsequent calls.
    function warp(uint256 newTimestamp) external;

    /// @dev Asserts that the next call reverts with exactly `revertData`.
    function expectRevert(bytes calldata revertData) external;

    /// @dev Asserts that the next call reverts with any data.
    function expectRevert() external;

    /// @dev Signs `digest` with `privateKey`, returning an ECDSA (v, r, s) triple.
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);

    /// @dev Derives the address for `privateKey`.
    function addr(uint256 privateKey) external returns (address);
}
