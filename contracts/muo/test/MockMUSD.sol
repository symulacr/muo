// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MockMUSD
/// @notice Deterministic, local ERC-20 + EIP-2612 mock used only by the MuoCore
///         regression suite. It is not deployed and is not the real MUSD.
/// @dev Behaviour mirrors the MUSD surface MuoCore depends on: 18 decimals,
///      `transfer`/`transferFrom` returning bool, and an EIP-2612 `permit`.
///      The mock is intentionally ordinary: it implements the standard
///      allowance and nonce semantics so that regression tests exercise the same
///      paths the real token would, and it exposes small test-only knobs
///      (`forceReturnFalse`, `forceRevert`) so the contract's `_pullBond` /
///      `_pushBond` failure mapping can be exercised without a malicious token.
contract MockMUSD {
    string public constant name = "Mezo USD";
    string public constant symbol = "MUSD";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    /// @dev EIP-712 type hashes, matching the canonical ERC20Permit layout.
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @dev Test-only switches used to simulate a misbehaving token.
    bool public forceReturnFalse;
    bool public forceRevert;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // Test-only helpers
    // ---------------------------------------------------------------------

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setForceReturnFalse(bool value) external {
        forceReturnFalse = value;
    }

    function setForceRevert(bool value) external {
        forceRevert = value;
    }

    // ---------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (forceRevert) revert("MockMUSD: forced revert");
        if (forceReturnFalse) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (forceRevert) revert("MockMUSD: forced revert");
        if (forceReturnFalse) return false;

        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockMUSD: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "MockMUSD: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------------
    // EIP-2612
    // ---------------------------------------------------------------------

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "MockMUSD: expired deadline");

        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "MockMUSD: invalid signature");

        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
