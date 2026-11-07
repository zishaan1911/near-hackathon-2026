from unittest.mock import MagicMock

from ingestion.ethereum import EthereumIngestionClient, parse_block


def make_client_with_mock_rpc(mock_rpc) -> EthereumIngestionClient:
    # Constructing with a dummy URL is safe — nothing touches the network
    # until _rpc() is called, and we replace _rpc entirely anyway so no
    # real HTTP request is ever made.
    client = EthereumIngestionClient(rpc_url="http://localhost:0")
    client._rpc = mock_rpc
    return client


def make_tx(to: str | None):
    return {"to": to}


def test_fetch_latest_metrics_shapes_a_raw_metrics_object():
    latest = {
        "number": hex(12345),
        "timestamp": hex(1_700_000_000),
        "baseFeePerGas": hex(25_000_000_000),
        "gasUsed": hex(14_000_000),
        "gasLimit": hex(30_000_000),
        "transactions": [
            make_tx("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"),  # DEX
            make_tx("0x0000000000000000000000000000000000dEaD"),  # not DEX
            make_tx(None),  # contract creation
        ],
    }
    responses = {
        "eth_getBlockByNumber": latest,
        # last entry is the trailing projected entry
        "eth_feeHistory": {"baseFeePerGas": [hex(20_000_000_000), hex(21_000_000_000), hex(25_000_000_000)]},
        "txpool_status": {"pending": "0x64"},  # 100
    }
    client = make_client_with_mock_rpc(MagicMock(side_effect=lambda method, params: responses[method]))
    metrics = client.fetch_latest_metrics()

    assert metrics.block_number == 12345
    assert metrics.timestamp == 1_700_000_000
    assert metrics.base_fee_wei == 25_000_000_000
    assert metrics.gas_used == 14_000_000
    assert metrics.gas_limit == 30_000_000
    assert metrics.block_tx_count == 3
    assert metrics.dex_tx_count == 1
    assert metrics.pending_tx_count == 100
    assert metrics.base_fee_history_wei == [20_000_000_000, 21_000_000_000]


def test_fee_history_trims_the_trailing_projected_entry():
    client = make_client_with_mock_rpc(MagicMock(return_value={"baseFeePerGas": ["0x1", "0x2", "0x3", "0x4"]}))

    history = client._fetch_base_fee_history()

    assert history == [1, 2, 3]  # last entry (the projection) dropped


def test_dex_transaction_matching_is_case_insensitive():
    client = make_client_with_mock_rpc(MagicMock())
    transactions = [
        make_tx("0x7A250D5630b4CF539739DF2C5DACB4C659F2488D"),  # different case, same address
        make_tx("0xnotarealdexaddress00000000000000000000"),
    ]

    assert client._count_dex_transactions(transactions) == 1


def test_dex_transaction_matching_handles_none_to_address():
    client = make_client_with_mock_rpc(MagicMock())
    transactions = [make_tx(None), make_tx(None)]

    assert client._count_dex_transactions(transactions) == 0


def test_pending_tx_count_falls_back_to_zero_when_txpool_unsupported():
    client = make_client_with_mock_rpc(MagicMock(side_effect=Exception("method not supported")))

    assert client._fetch_pending_tx_count() == 0


def test_pending_tx_count_falls_back_to_zero_on_missing_result_shape():
    client = make_client_with_mock_rpc(MagicMock(return_value={"unexpected": "shape"}))

    assert client._fetch_pending_tx_count() == 0


def test_custom_history_window_is_passed_to_fee_history():
    mock_rpc = MagicMock(return_value={"baseFeePerGas": ["0x1", "0x2"]})
    client = EthereumIngestionClient(rpc_url="http://localhost:0", history_window_blocks=7)
    client._rpc = mock_rpc

    client._fetch_base_fee_history()

    mock_rpc.assert_called_once_with("eth_feeHistory", [hex(7), "latest", []])


def test_parse_block_decodes_hex_fields():
    sample = parse_block(
        {
            "number": "0x10",
            "timestamp": "0x20",
            "baseFeePerGas": "0x30",
            "gasUsed": "0x40",
            "gasLimit": "0x50",
            "transactions": [make_tx("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"), make_tx(None)],
        }
    )

    assert (sample.number, sample.timestamp, sample.base_fee_wei) == (16, 32, 48)
    assert (sample.gas_used, sample.gas_limit) == (64, 80)
    assert (sample.block_tx_count, sample.dex_tx_count) == (2, 1)
