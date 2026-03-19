// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./interfaces/IERC20.sol";
import {IStreamChannel} from "./interfaces/IStreamChannel.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";

/// @title StreamChannel
/// @notice MPP-compatible unidirectional payment channel escrow for streaming payments on any EVM chain.
/// @dev Adapted from Tempo's TempoStreamChannel — replaces TIP-20 with standard ERC-20.
///      Users deposit ERC-20 tokens, sign cumulative vouchers off-chain, and servers
///      settle or close channels at any time. Channels have no expiry — they are closed
///      either cooperatively by the server or after a grace period following a user's close request.
contract StreamChannel is IStreamChannel, EIP712 {

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint128 cumulativeAmount)");

    uint64 public constant CLOSE_GRACE_PERIOD = 15 minutes;

    mapping(bytes32 => Channel) public channels;

    // ──────────────────────────────────────────────
    //  EIP-712 domain
    // ──────────────────────────────────────────────

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "Tempo Stream Channel";
        version = "1";
    }

    // ──────────────────────────────────────────────
    //  Token validation (replaces TempoUtilities.isTIP20)
    // ──────────────────────────────────────────────

    /// @dev On Tempo this checks a magic address prefix. On C-Chain we just
    ///      verify the address has deployed code (i.e. is a contract).
    function _isValidToken(address token) internal view returns (bool) {
        return token.code.length > 0;
    }

    // ──────────────────────────────────────────────
    //  Safe ERC-20 helpers (handles non-bool-returning tokens like USDT)
    // ──────────────────────────────────────────────

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    // ──────────────────────────────────────────────
    //  Core functions
    // ──────────────────────────────────────────────

    function open(
        address payee,
        address token,
        uint128 deposit,
        bytes32 salt,
        address authorizedSigner
    )
        external
        override
        returns (bytes32 channelId)
    {
        if (payee == address(0)) revert InvalidPayee();
        if (!_isValidToken(token)) revert InvalidToken();
        if (deposit == 0) revert ZeroDeposit();

        channelId = computeChannelId(msg.sender, payee, token, salt, authorizedSigner);

        if (channels[channelId].payer != address(0) || channels[channelId].finalized) {
            revert ChannelAlreadyExists();
        }

        channels[channelId] = Channel({
            payer: msg.sender,
            payee: payee,
            token: token,
            authorizedSigner: authorizedSigner,
            deposit: deposit,
            settled: 0,
            closeRequestedAt: 0,
            finalized: false
        });

        _safeTransferFrom(token, msg.sender, address(this), deposit);

        emit ChannelOpened(channelId, msg.sender, payee, token, authorizedSigner, salt, deposit);
    }

    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata signature
    )
        external
        override
    {
        Channel storage channel = channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payee) revert NotPayee();
        if (cumulativeAmount > channel.deposit) revert AmountExceedsDeposit();
        if (cumulativeAmount <= channel.settled) revert AmountNotIncreasing();

        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        bytes32 digest = _hashTypedData(structHash);
        address signer = ECDSA.recoverCalldata(digest, signature);

        address expectedSigner =
            channel.authorizedSigner != address(0) ? channel.authorizedSigner : channel.payer;

        if (signer != expectedSigner) revert InvalidSignature();

        uint128 delta = cumulativeAmount - channel.settled;
        channel.settled = cumulativeAmount;

        _safeTransfer(channel.token, channel.payee, delta);

        emit Settled(
            channelId, channel.payer, channel.payee, cumulativeAmount, delta, channel.settled
        );
    }

    function topUp(bytes32 channelId, uint256 additionalDeposit) external override {
        Channel storage channel = channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();
        if (additionalDeposit == 0) revert ZeroDeposit();
        if (additionalDeposit > type(uint128).max - channel.deposit) revert DepositOverflow();

        channel.deposit += uint128(additionalDeposit);

        _safeTransferFrom(channel.token, msg.sender, address(this), additionalDeposit);

        if (channel.closeRequestedAt != 0) {
            channel.closeRequestedAt = 0;
            emit CloseRequestCancelled(channelId, channel.payer, channel.payee);
        }

        emit TopUp(channelId, channel.payer, channel.payee, additionalDeposit, channel.deposit);
    }

    function requestClose(bytes32 channelId) external override {
        Channel storage channel = channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();

        if (channel.closeRequestedAt == 0) {
            channel.closeRequestedAt = uint64(block.timestamp);
            emit CloseRequested(
                channelId, channel.payer, channel.payee, block.timestamp + CLOSE_GRACE_PERIOD
            );
        }
    }

    function close(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata signature
    )
        external
        override
    {
        Channel storage channel = channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payee) revert NotPayee();

        address token = channel.token;
        address payer = channel.payer;
        address payee = channel.payee;
        uint128 deposit = channel.deposit;

        uint128 settledAmount = channel.settled;
        uint128 delta = 0;

        if (cumulativeAmount > settledAmount) {
            if (cumulativeAmount > deposit) revert AmountExceedsDeposit();

            bytes32 structHash =
                keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
            bytes32 digest = _hashTypedData(structHash);
            address signer = ECDSA.recoverCalldata(digest, signature);

            address expectedSigner =
                channel.authorizedSigner != address(0) ? channel.authorizedSigner : payer;

            if (signer != expectedSigner) revert InvalidSignature();

            delta = cumulativeAmount - settledAmount;
            settledAmount = cumulativeAmount;
        }

        uint128 refund = deposit - settledAmount;
        _clearAndFinalize(channelId);

        if (delta > 0) {
            _safeTransfer(token, payee, delta);
        }

        if (refund > 0) {
            _safeTransfer(token, payer, refund);
        }

        emit ChannelClosed(channelId, payer, payee, settledAmount, refund);
    }

    function withdraw(bytes32 channelId) external override {
        Channel storage channel = channels[channelId];

        if (channel.finalized) revert ChannelFinalized();
        if (channel.payer == address(0)) revert ChannelNotFound();
        if (msg.sender != channel.payer) revert NotPayer();

        address token = channel.token;
        address payer = channel.payer;
        address payee = channel.payee;
        uint128 deposit = channel.deposit;
        uint128 settledAmount = channel.settled;

        bool closeGracePassed = channel.closeRequestedAt != 0
            && block.timestamp >= channel.closeRequestedAt + CLOSE_GRACE_PERIOD;

        if (!closeGracePassed) revert CloseNotReady();

        uint128 refund = deposit - settledAmount;
        _clearAndFinalize(channelId);

        if (refund > 0) {
            _safeTransfer(token, payer, refund);
        }

        emit ChannelExpired(channelId, payer, payee);
        emit ChannelClosed(channelId, payer, payee, settledAmount, refund);
    }

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    function getChannel(bytes32 channelId) external view override returns (Channel memory) {
        return channels[channelId];
    }

    function computeChannelId(
        address payer,
        address payee,
        address token,
        bytes32 salt,
        address authorizedSigner
    )
        public
        view
        override
        returns (bytes32)
    {
        return keccak256(
            abi.encode(payer, payee, token, salt, authorizedSigner, address(this), block.chainid)
        );
    }

    function domainSeparator() external view override returns (bytes32) {
        return _domainSeparator();
    }

    function getVoucherDigest(
        bytes32 channelId,
        uint128 cumulativeAmount
    )
        external
        view
        override
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        return _hashTypedData(structHash);
    }

    function getChannelsBatch(bytes32[] calldata channelIds)
        external
        view
        override
        returns (Channel[] memory channelStates)
    {
        uint256 length = channelIds.length;
        channelStates = new Channel[](length);

        for (uint256 i = 0; i < length; ++i) {
            channelStates[i] = channels[channelIds[i]];
        }
    }

    // ──────────────────────────────────────────────
    //  Internal
    // ──────────────────────────────────────────────

    function _clearAndFinalize(bytes32 channelId) internal {
        delete channels[channelId];
        channels[channelId].finalized = true;
    }
}
