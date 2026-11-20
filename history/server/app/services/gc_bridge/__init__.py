"""ERP → 群控(groupcontrol-server :8100)桥:真机上下架/待发货。

- assembler.build_publish_spec:从 SkuListingInfo(优先)/Sku(回退)组装 gc PublishSpec。
- client:调 gc-server 的账号 upsert(设备号↔账号名映射)与 publish/delist 作业接口。
"""
