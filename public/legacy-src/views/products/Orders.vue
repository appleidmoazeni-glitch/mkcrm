<template>
    <main :class="['main-content', 'full-height', searchInput?'fh-70':'fh-69']">
        <div class="row">
            <div class="col-lg-12">
                <b-overlay :show="ordersLoading" opacity="0.6" rounded="lg" class="card">
                    <form method="post" id="filters">
                        <div class="card-header">
                            <h5>
                                سفارشات {{(ordersList.length > 1 && !searchInput) ? new Date(Date.now() - (86400000*(page-1))).echoFa("d F") : ""}}
                                <div class="d-none d-lg-inline">
                                    <span class="badge badge-dark mr-2">{{ counterOrders.all }}</span>
                                    <span class="badge badge-waiting mr-1">انتظار {{ counterOrders.waiting }}</span>
                                    <span class="badge badge-unpay mr-1">لغو {{ counterOrders.unpay }}</span>
                                    <span class="badge badge-progress mr-1">پردازش {{ counterOrders.progress }}</span>
                                    <span class="badge badge-cancel mr-1">کنسل {{ counterOrders.cancel }}</span>
                                    <span class="badge badge-factor mr-1">فاکتور {{ counterOrders.factor }}</span>
                                    <span class="badge badge-send mr-1">ارسال {{ counterOrders.send }}</span>
                                    <span class="badge badge-receive mr-1">تحویل {{ counterOrders.receive }}</span>
                                </div>
                            </h5>
                            <div class="items form-inline">
                                <input name="search" @keypress.enter.prevent="getOrdersList" type="search" class="form-control just" placeholder="جستجو ..." />
                                <button class="btn btn-light mr-2" @click="getOrdersList" type="button"><i class="ti-reload"></i></button>
                                <button class="btn btn-light mr-2" @click="getOrdersList('all')" type="button"><i class="fa fa-list"></i></button>
                                <button class="btn btn-light mr-2" @click="ordersFilter" type="button"><i class="fa fa-filter"></i></button>
                            </div>
                        </div>
                        <div class="card-header bg-secondary-bright" style="display: none" id="ordersFilter">
                            <strong class="m-l-15">وضعیت کالا: </strong>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="waiting" type="checkbox" class="custom-control-input" id="customSwitchInline1">
                                <label class="custom-control-label" for="customSwitchInline1">انتظار</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="unpay" type="checkbox" class="custom-control-input" id="customSwitchInline2">
                                <label class="custom-control-label" for="customSwitchInline2">لغو</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="progress" type="checkbox" class="custom-control-input" id="customSwitchInline3">
                                <label class="custom-control-label" for="customSwitchInline3">پردازش</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="cancel" type="checkbox" class="custom-control-input" id="customSwitchInline4">
                                <label class="custom-control-label" for="customSwitchInline4">کنسل</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="factor" type="checkbox" class="custom-control-input" id="customSwitchInline5">
                                <label class="custom-control-label" for="customSwitchInline5">فاکتور</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="send" type="checkbox" class="custom-control-input" id="customSwitchInline6">
                                <label class="custom-control-label" for="customSwitchInline6">ارسال</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="receive" type="checkbox" class="custom-control-input" id="customSwitchInline7">
                                <label class="custom-control-label" for="customSwitchInline7">تحویل</label>
                            </div>

                            <hr>

                            <strong class="m-l-15">تحویل کالا: </strong>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="d_center" type="checkbox" class="custom-control-input" id="csDelivery1">
                                <label class="custom-control-label" for="csDelivery1">دفتر مرکزی</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="d_pishtaz" type="checkbox" class="custom-control-input" id="csDelivery2">
                                <label class="custom-control-label" for="csDelivery2">پیشتاز</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="d_tipax" type="checkbox" class="custom-control-input" id="csDelivery3">
                                <label class="custom-control-label" for="csDelivery3">تیپاکس</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="d_mashhad" type="checkbox" class="custom-control-input" id="csDelivery4">
                                <label class="custom-control-label" for="csDelivery4">مشهد</label>
                            </div>
                            <div class="custom-control custom-switch custom-control-inline">
                                <input name="d_sefareshi" type="checkbox" class="custom-control-input" id="csDelivery5">
                                <label class="custom-control-label" for="csDelivery5">سفارشی</label>
                            </div>

                            <hr>

                            <div class="d-flex flex-row-reverse">
                                <button @click="applyFilter" id="apply-filters" type="button" class="btn btn-primary">اعمال فیلتر</button>
                                <button @click="filterNotTracking" type="button" class="btn btn-light ml-2">بدون کد رهگیری</button>
                            </div>
                        </div>
                    </form>
                    <div class="card-body p-0 table-orders">
                        <div class="card-scroll h-100">
                            <div class="table-responsive">
                                <table class="table" width="100%">
                                    <thead>
                                    <tr>
                                        <th width="50">شماره</th>
                                        <th>نام</th>
                                        <th><i class="ti-cup text-warning"></i></th>
                                        <th><i class="ti-face-sad text-danger"></i></th>
                                        <th width="59">وضعیت</th>
<!--                                        <th>sms</th>-->
                                        <th width="59">ارسال</th>
<!--                                        <th>sms</th>-->
                                        <th>مبلغ</th>
                                        <th>بانک</th>
                                        <th>شیوه ارسال</th>
                                        <th width="100">زمان پرداخت</th>
                                        <th width="190">رهگیری پست</th>
                                        <th width="100">زمان ارسال</th>
                                        <th>بازه</th>
                                        <th>موعد</th>
                                        <th></th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    <tr v-if="ordersList.length == 0"><td colspan="15" class="text-center">-- هیچ شماره ای درج نشده است --</td></tr>
                                    <tr v-for="(order, index) of ordersList" :class="'os-'+getStatusName(order).name">
                                        <td><a :href="'https://mashadkala.com/Admin/Order/Edit/' + order.id" target="_new">{{order.id}}</a></td>
                                        <td>
                                          <template v-if="parseInt(order.bankAmount) != parseInt(order.OrderTotal)">
                                            <i class="fa ml-1 fa-exclamation-triangle text-danger"></i><i class="fa ml-1 fa-exclamation-triangle text-danger"></i><i class="fa ml-1 fa-exclamation-triangle text-danger"></i><i class="fa ml-1 fa-exclamation-triangle text-danger"></i>
                                            <strong>دزد: </strong><span>{{order.bankAmount}}</span>
                                          </template>
                                          <i v-else :class="['fa ml-1', getTypeOfCustomer(index).icon]"></i>
                                          {{order.lastname}}
                                        </td>
                                        <td>{{order.success_y}}</td>
                                        <td>{{order.cancel_y}}</td>
                                        <td>
                                            <div class="dropdown ml-2">
                                                <a href="#" class="btn btn-icon btn-sm" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><i :class="['is-big', orderStatusTitle(order.OrderStatusId).icon]"></i></a>
                                                <div class="dropdown-menu dropdown-menu-right">
                                                    <button @click="setOrderStatus(order.id, 'order', 10, index)" :class="['dropdown-item', order.OrderStatusId == 10?'active':'']" type="button"><i class="fad fa-money-check"></i> انتظار</button>
                                                    <button @click="setOrderStatus(order.id, 'order', 20, index)" :class="['dropdown-item', order.OrderStatusId == 20?'active':'']" type="button"><i class="fad fa-spinner"></i> پردازش</button>
                                                    <button @click="setOrderStatus(order.id, 'order', 30, index)" :class="['dropdown-item', order.OrderStatusId == 30?'active':'']" type="button"><i class="fa fa-check"></i> تکمیل</button>
                                                    <button @click="setOrderStatus(order.id, 'order', 40, index)" :class="['dropdown-item', order.OrderStatusId == 40?'active':'']" type="button"><i class="fa fa-times"></i> لغو</button>
                                                </div>
                                            </div>
                                        </td>
<!--                                        <td><i :class="['fa', order.ONotify?'fa-envelope':'fa-envelope-o', 'is-big']"></i></td>-->
                                        <td>
                                            <div class="dropdown ml-2">
                                                <a href="#" class="btn btn-icon btn-sm" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><i :class='["fa", "is-big", shippingStatusTitle(order.ShippingStatusId).icon]'></i></a>
                                                <div class="dropdown-menu dropdown-menu-right">
                                                    <button @click="setOrderStatus(order.id, 'shipp', 20, index)" :class="['dropdown-item', order.ShippingStatusId == 20?'active':'']" type="button"><i :class='["is-big", shippingStatusTitle(20).icon]'></i> {{shippingStatusTitle(20).title}}</button>
                                                    <button @click="setOrderStatus(order.id, 'shipp', 30, index)" :class="['dropdown-item', order.ShippingStatusId == 30?'active':'']" type="button"><i :class='["is-big", shippingStatusTitle(30).icon]'></i> {{shippingStatusTitle(30).title}}</button>
                                                    <button @click="setOrderStatus(order.id, 'shipp', 40, index)" :class="['dropdown-item', order.ShippingStatusId == 40?'active':'']" type="button"><i :class='["is-big", shippingStatusTitle(40).icon]'></i> {{shippingStatusTitle(40).title}}</button>
                                                </div>
                                            </div>
                                        </td>
<!--                                        <td><i :class="['fa', order.SNotify?'fa-envelope':'fa-envelope-o', 'is-big']"></i></td>-->
                                        <td><i v-if="order.OrderTotal > 20000000" class="fa fa-exclamation text-danger"></i> {{number_format(order.OrderTotal)}}</td>
                                        <td><img :src="getBankImage(index)" width="20"></td>
                                        <td>{{ShippingMethodTitle(order.ShippingMethod)}}</td>
                                        <td dir="ltr">{{order.PaidDateUtc ? new Date(order.PaidDateUtc).echoFa("y/n/d - H:i") : "-"}}</td>
                                        <td><button @click.right="openTracking(index)" class="btn btn-sm" data-toggle="modal" data-target="#trackingCodeModal" :data-index="index">{{order.trackingnumber ? order.trackingnumber : "-"}}</button></td>
                                        <td dir="ltr">{{order.createdOnUtc ? new Date(order.createdOnUtc).echoFa("Y/m/d - H:i") : "-"}}</td>
                                        <td>{{(order.PaidDateUtc && order.createdOnUtc) ? calcSentRate(order.PaidDateUtc, order.createdOnUtc) : "-"}}</td>
                                        <td>{{order.DeliveryDate ? new Date(order.DeliveryDate).echoFa("m/d") : ""}}</td>
                                        <td class="text-left p-0">
                                          <i v-if="order.Vatnumber=='True'" class="fad fa-receipt text-warning is-big is-middle"></i>
                                          <b-button class="btn-sm" data-toggle="modal" data-target="#setComment" :data-index="index" variant="link" v-b-popover.hover.right="order.admincomment||''"><i :class="['fa fa-info-circle is-big ml-2', order.admincomment ? 'text-danger' : 'text-muted']"></i></b-button>
                                        </td>
                                    </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    <div v-if="!searchInput" class="card-footer d-flex flex-row-reverse justify-content-between align-items-center">
                        <b-pagination-nav v-model="page" size="sm" :number-of-pages="pages" base-url="#" first-number last-number></b-pagination-nav>
                        <div class="d-none d-lg-inline">
                            <span>جمع واریزی روزانه: {{ number_format(counterOrders.all_payments) }}</span>
                            <span class="mr-4"><img src="/admin/assets/media/image/bank-up.png" width="20"> {{ number_format(counterOrders.up_payments) }}</span>
                            <span class="mr-4"><img src="/admin/assets/media/image/bank-saman.png" width="20"> {{ number_format(counterOrders.saman_payments) }}</span>
                            <span class="mr-4"><img src="/admin/assets/media/image/bank-mellat.png" width="20"> {{ number_format(counterOrders.mellat_payments) }}</span>
                        </div>
<!--                        <ul class="pagination">-->
<!--                            <li :class="['page-item', 'previous', page==1?'disabled':'']"><a href="#" tabindex="0" class="page-link" @click.prevent="page&#45;&#45;">قبلی</a></li>-->
<!--                            <li v-for="n in pages" v-if="pages>2" :class="['page-item',page==n?'active':'']">-->
<!--                                <a href="#" tabindex="0" class="page-link" @click.prevent="gotoPage(n)">{{n}}</a>-->
<!--                            </li>-->
<!--                            <li :class="['page-item', 'next', (page==pages)?'disabled':'']"><a href="#" tabindex="0" class="page-link" @click.prevent="page++">بعدی</a></li>-->
<!--                        </ul>-->
<!--                        <div class="align-middle"><input type="number" min="1" v-model="page" class="form-control goto-page" placeholder="صفحه"></div>-->
                    </div>
                </b-overlay>
            </div>
        </div>
        <div class="card mt-3 d-lg-none">
            <div class="p-5">
                <span class="mr-2 col-sm-12">جمع واریزی روزانه: {{ number_format(counterOrders.all_payments) }}</span>
                <span class="mr-2 col-sm-12"><img src="/admin/assets/media/image/bank-up.png" width="20"> {{ number_format(counterOrders.up_payments) }}</span>
                <span class="mr-2 col-sm-12"><img src="/admin/assets/media/image/bank-saman.png" width="20"> {{ number_format(counterOrders.saman_payments) }}</span>
                <span class="mr-2 col-sm-12"><img src="/admin/assets/media/image/bank-mellat.png" width="20"> {{ number_format(counterOrders.mellat_payments) }}</span>
            </div>
        </div>
        <div class="row mt-3 mb-5 d-lg-none">
            <div class="col-12">
                <span class="badge badge-dark mr-2">{{ counterOrders.all }}</span>
                <span class="badge badge-waiting mr-1">انتظار {{ counterOrders.waiting }}</span>
                <span class="badge badge-unpay mr-1">لغو {{ counterOrders.unpay }}</span>
                <span class="badge badge-progress mr-1">پردازش {{ counterOrders.progress }}</span>
                <span class="badge badge-cancel mr-1">کنسل {{ counterOrders.cancel }}</span>
                <span class="badge badge-factor mr-1">فاکتور {{ counterOrders.factor }}</span>
                <span class="badge badge-send mr-1">ارسال {{ counterOrders.send }}</span>
                <span class="badge badge-receive mr-1">تحویل {{ counterOrders.receive }}</span>
            </div>
        </div>
        <div class="modal fade" id="trackingCodeModal" tabindex="-1" role="dialog" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered" role="document">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">کد رهگیری</h5>
                        <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
                    </div>
                    <div class="modal-body">
                        <form @submit.prevent>
                            <div class="form-group">
                                <label class="col-form-label">کد رهگیری:</label>
                                <input type="text" class="form-control" name="trackingnumber" @keypress.enter="setTrackingCode">
                                <input type="hidden" class="form-control" name="id">
                            </div>
                        </form>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
                        <button type="button" @click="setTrackingCode" class="btn btn-primary">ثبت</button>
                    </div>
                </div>
            </div>
        </div>
        <modal-comment :ordersList="ordersList" />
    </main>
</template>

<script>
import axios from "axios";
import util from "../../assets/pureFunctions.js"
import querystring from 'querystring';
import ModalComment from "../../components/ModalComment";
export default {
    data(){
        return {
            page: 1,
            pages: 16,
            ordersList: [],
            number_format: util.number_format,
            ordersLoading: true,
            modalLoading: true,
            searchInput: false,
            counterOrders: {all:0, waiting:0, unpay:0, progress:0, cancel:0, factor:0, send:0, receive:0, all_payments: 0, mellat_payments: 0, saman_payments: 0, up_payments: 0},
        }
    },
    methods: {
        ordersFilter(){
            $("#ordersFilter").toggle(300);
        },
        getOrdersList(type = ""){
            if( (document.getElementsByName('search')[0].value.length > 0) || type == 'all' || type == 'filterNotTracking' ) this.searchInput = true;
            else this.searchInput = false;

            this.ordersLoading = true;
            let data = querystring.parse($("#filters").serialize());
            data.page = this.page;
            data.type = type;
            axios.post('/admin/products/ordersList', data).then(({data}) => {
                this.ordersList = data;
                this.ordersLoading = false;

                this.counterOrders = {all:0, waiting:0, unpay:0, progress:0, cancel:0, factor:0, send:0, receive:0, all_payments: 0, mellat_payments: 0, saman_payments: 0, up_payments: 0};
                for(let ol of data){
                    this.counterOrders.all++;
                    if( ol.PaymentStatusId == 30 ) {
                        this.counterOrders.all_payments += ol.OrderTotal;
                        if( ol.payment == "Payments.Mellat" ) this.counterOrders.mellat_payments += ol.OrderTotal;
                        if( ol.payment == "Payments.Saman" ) this.counterOrders.saman_payments += ol.OrderTotal;
                        if( ol.payment == "Payments.AsanPardakht" ) this.counterOrders.up_payments += ol.OrderTotal;
                    }
                    if( ol.PaymentStatusId == 10 && ol.OrderStatusId == 10 && ol.ShippingStatusId == 20 ) {this.counterOrders.waiting++;continue;}
                    if( ol.PaymentStatusId == 10 && ol.OrderStatusId == 40 && ol.ShippingStatusId == 20 ) {this.counterOrders.unpay++; continue;}
                    if( ol.PaymentStatusId == 30 && ol.OrderStatusId == 20 && ol.ShippingStatusId == 20 ) {this.counterOrders.progress++; continue;}
                    if( ol.PaymentStatusId == 30 && ol.OrderStatusId == 40 && ol.ShippingStatusId == 20 ) {this.counterOrders.cancel++; continue;}
                    if( ol.PaymentStatusId == 30 && ol.OrderStatusId == 30 && ol.ShippingStatusId == 20 ) {this.counterOrders.factor++; continue;}
                    if( ol.OrderStatusId == 30 && ol.ShippingStatusId == 30 ) {this.counterOrders.send++; continue;}
                    if( ol.OrderStatusId == 30 && ol.ShippingStatusId == 40 ) {this.counterOrders.receive++; continue;}
                }
                // $(".card-scroll").niceScroll({railalign: "left"});
            })
        },
        openTracking(index){
          window.open('/admin/products/postTracking/' + this.ordersList[index].trackingnumber, "_blank");
          // window.open('https://tracking.post.ir/?id=' + this.ordersList[index].trackingnumber, "_blank");
        },
        async setOrderStatus(id, type, value, index){
            const {data} = await axios.put('/admin/products/ordersList', {id, type, value});
            if( type == "order" ){
                if( data.ok ) this.ordersList[index].OrderStatusId = value;
                else toastr['error'](data.error);
            }
            if( type == "shipp" ){
                if( data.ok ){
                    console.log(data);
                    this.ordersList[index].ShippingStatusId = value;
                    if( !isNaN(data.trackingnumber) ) this.ordersList[index].trackingnumber = data.trackingnumber;
                }else toastr['error'](data.error);
            }
        },
        setTrackingCode(){
            axios.put('/admin/products/ordersList.setTrackingCode', $("#trackingCodeModal form").serialize()).then(({data}) => {
                if( data.ok ) {
                    toastr['success'](data.msg);
                    this.ordersList[this.activeIndex].trackingnumber = $("#trackingCodeModal form [name=trackingnumber]").val();
                    this.ordersList[this.activeIndex].createdOnUtc = data.createdOnUtc;
                    $('#trackingCodeModal').modal('hide');
                }else{
                    toastr['error'](data.error);
                }
            });
        },
        getStatusName(order){
            if( order.PaymentStatusId == 10 && order.OrderStatusId == 10 && order.ShippingStatusId == 20 ) return {name:"waiting", color: "#ffffff"};
            if( order.PaymentStatusId == 10 && order.OrderStatusId == 40 && order.ShippingStatusId == 20 ) return {name:"unpay", color: "#d23e3e"};
            if( order.PaymentStatusId == 30 && order.OrderStatusId == 20 && order.ShippingStatusId == 20 ) return {name:"progress", color: "#7b93b3"};
            if( order.PaymentStatusId == 30 && order.OrderStatusId == 40 && order.ShippingStatusId == 20 ) return {name:"cancel", color: "#c287d0"};
            if( order.PaymentStatusId == 30 && order.OrderStatusId == 30 && order.ShippingStatusId == 20 ) return {name:"factor", color: "#6fcdde"};
            if( order.OrderStatusId == 30 && order.ShippingStatusId == 30 ) return {name:"send", color: "#7fd970"};
            if( order.OrderStatusId == 30 && order.ShippingStatusId == 40 ) return {name:"receive", color: "rgba(67,137,49,0.51)"};
            return {name:"other", color: ""}
        },
        getBankImage(index){
            const order = this.ordersList[index];
            if( order.payment == "Payments.Saman" ) return "/admin/assets/media/image/bank-saman.png";
            else if( order.payment == "Payments.Mellat" ) return "/admin/assets/media/image/bank-mellat.png";
            else if( order.payment == "Payments.AsanPardakht" ) return "/admin/assets/media/image/bank-up.png";
            else return "";
        },
        applyFilter(){
            this.getOrdersList();
            $('#ordersFilter').slideUp();
        },
        filterNotTracking(){
            this.getOrdersList('filterNotTracking');
            $("#ordersFilter").slideUp();
        },
        getTypeOfCustomer(index){
            const order = this.ordersList[index];
            let customerType = {name:"none", icon:""};
            if( order.success_all == 0 ){
                customerType = {name:"new", icon:"fa-certificate text-success"};
            }
            if( (order.sumsuccess_y >= 30000000 && order.success_y >= 10) || (order.sumsuccess_m >= 15000000 || order.success_m >= 5) ){
                customerType = {name:"gold", icon:"fa-star text-warning"};
            }
            if( order.cancel_last > 0 ){
                customerType = {name:"danger", icon:"fa-exclamation-triangle text-danger"};
            }
            return customerType;
        },
        orderStatusTitle(id){
            switch (id){
                case 10: return {title: "انتظار", icon: "fad fa-money-check"};
                case 20: return {title: "پردازش", icon: "fad fa-spinner text-muted"};
                case 30: return {title: "تکمیل", icon: "fas fa-check text-success"};
                case 40: return {title: "لغو", icon: "fa fa-times text-danger"};
                default: return {title: "-", icon: ""};
            }
        },
        shippingStatusTitle(id){
            switch (id){
                case 20: return {title: "حمل نشده", icon: "fa fa-ban text-danger"};
                case 30: return {title: "ارسال شده", icon: "fa fa-truck text-warning"};
                case 40: return {title: "تحویل شده", icon: "fa fa-check-circle text-success"};
                default: return {title: "?", icon: "fa fa-question text-muted"};
            }
        },
        ShippingMethodTitle(str){
            switch (str){
                case "ارسال شهرستان پس کرایه(تیپاکس،باربری)": return "تیپاکس";
                case "ارسال مشهد": return "مشهد";
                case "ارسال شهرستان (پست پیشتاز،سپیدبال)": return "پیشتاز";
                case "تحویل در دفتر مرکزی": return "مرکزی";
                case "ارسال شهرستان (پست سفارشی)": return "سفارشی";
                default: return str;
            }
        },
        calcSentRate(paidDate, sendDate){
            const date1 = new Date(paidDate);
            const date2 = new Date(sendDate);
            const diffTime = Math.abs(date2 - date1);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays;
        },
        defaultFilters(){
            const s_waiting = isNaN(localStorage.getItem('products.waiting')) ? localStorage.getItem('products.waiting') == "true" : true;
            const s_unpay = isNaN(localStorage.getItem('products.unpay')) ? localStorage.getItem('products.unpay') == "true" : false;
            const s_progress = isNaN(localStorage.getItem('products.progress')) ? localStorage.getItem('products.progress') == "true" : true;
            const s_cancel = isNaN(localStorage.getItem('products.cancel')) ? localStorage.getItem('products.cancel') == "true" : false;
            const s_factor = isNaN(localStorage.getItem('products.factor')) ? localStorage.getItem('products.factor') == "true" : true;
            const s_send = isNaN(localStorage.getItem('products.send')) ? localStorage.getItem('products.send') == "true" : true;
            const s_receive = isNaN(localStorage.getItem('products.receive')) ? localStorage.getItem('products.receive') == "true" : true;

            $(function(){
                $("[name=waiting]").prop('checked', !!s_waiting);
                $("[name=unpay]").prop('checked', !!s_unpay);
                $("[name=progress]").prop('checked', !!s_progress);
                $("[name=cancel]").prop('checked', !!s_cancel);
                $("[name=factor]").prop('checked', !!s_factor);
                $("[name=send]").prop('checked', !!s_send);
                $("[name=receive]").prop('checked', !!s_receive);
            });

            const d_center = isNaN(localStorage.getItem('products.d_center')) ? localStorage.getItem('products.d_center') == "true" : true;
            const d_pishtaz = isNaN(localStorage.getItem('products.d_pishtaz')) ? localStorage.getItem('products.d_pishtaz') == "true" : true;
            const d_tipax = isNaN(localStorage.getItem('products.d_tipax')) ? localStorage.getItem('products.d_tipax') == "true" : true;
            const d_mashhad = isNaN(localStorage.getItem('products.d_mashhad')) ? localStorage.getItem('products.d_mashhad') == "true" : true;
            const d_sefareshi = isNaN(localStorage.getItem('products.d_sefareshi')) ? localStorage.getItem('products.d_sefareshi') == "true" : true;

            $(function(){
                $("[name=d_center]").prop('checked', !!d_center);
                $("[name=d_pishtaz]").prop('checked', !!d_pishtaz);
                $("[name=d_tipax]").prop('checked', !!d_tipax);
                $("[name=d_mashhad]").prop('checked', !!d_mashhad);
                $("[name=d_sefareshi]").prop('checked', !!d_sefareshi);
            });
        },
        gotoPage(n){
            this.page = n;
        },
    },
    watch:{
        page: {
            handler: function(){
                this.getOrdersList();
            }
        }
    },
    created() {
        const vm = this;

        this.defaultFilters();

        $(function (){
            // $("#filters :input").change(function (){
            //     vm.getOrdersList();
            // });
            vm.getOrdersList();

            $("#ordersFilter .custom-switch input").click(function(){
                // console.log(`products.${$(this).attr('name')}`, ':', $(this).prop('checked'));
                localStorage.setItem(`products.${$(this).attr('name')}`, $(this).prop('checked'));
                // localStorage.setItem(`products.${$(this).attr('name')}`, $(this).prop('checked'));
            });

            $('#trackingCodeModal').on('show.bs.modal', function (event) {
                var btn = $(event.relatedTarget), modal = $(this), i = btn.data('index');

                modal.find('.modal-title').text('ثبت کد رهگیری سفارش: ' + vm.ordersList[i].id);
                modal.find('.modal-body [name=trackingnumber]').val(vm.ordersList[i].trackingnumber);
                modal.find('.modal-body [name=id]').val(vm.ordersList[i].id);
                vm.activeIndex = i;

                setTimeout(function (){
                    modal.find('.modal-body [name=trackingnumber]').focus();
                }, 500);
            });
        });

        // let rs = this.resetSearch;
        // document.querySelector("[type=search]")[0].addEventListener("search", function(event) {
        //     rs();
        // });
    },
    mounted() {
        document.querySelector("[type=search]").addEventListener('search', this.getOrdersList);
    },
    components: {
        'modal-comment': ModalComment
    }
}
</script>
<style scoped>
.badge.badge-waiting {background: #f8f3bb;}
.badge.badge-unpay {background: #ff9a74;}
.badge.badge-progress {background: #d3d3df;}
.badge.badge-cancel {background: #ffb0ff;}
.badge.badge-factor {background: #a5dafc;}
.badge.badge-send {background: #abe252;}
.badge.badge-receive {background: #0cc510;}

body.dark .badge.badge-waiting, body.dark .badge.badge-unpay, body.dark .badge.badge-progress, body.dark .badge.badge-cancel, body.dark .badge.badge-factor, body.dark .badge.badge-send, body.dark .badge.badge-receive {color: #000 !important;}
body.dark .table tbody{color: #1b1b1b;}

.btn-link:hover, .btn-link:focus{text-decoration: none;}
.full-height.fh-69 .card .card-body {height: calc(100vh - 214px);}
.full-height.fh-70 .card .card-body {height: calc(100vh - 155px);}
.items{
    /* margin-top: 10px; */
    position: absolute;
    left: 11px;
    top: 8px;
}
.table-responsive{min-height: 200px}
.table td {padding: 0 0.2rem;}
/*.table tbody tr{transition: opacity 0.2s 1s;}*/
.os-waiting {background-color: #f8f3bb72;}
.os-unpay {background-color: #ff9a7472;}
.os-progress {background-color: #d3d3df72;}
.os-cancel {background-color: #ffb0ff72;}
.os-factor {background-color: #a5dafc72;}
.os-send {background-color: #abe25272;}
.os-receive {background-color: #0cc51072;}

.os-waiting:hover {background-color: #f8f3bb99;}
.os-unpay:hover {background-color: #ff9a7499;}
.os-progress:hover {background-color: #d3d3df99;}
.os-cancel:hover {background-color: #ffb0ff99;}
.os-factor:hover {background-color: #a5dafc99;}
.os-send:hover {background-color: #abe25299;}
.os-receive:hover {background-color: #0cc51099;}

body.dark .os-other {background-color: #76767672;}

i.fa-envelope-o{color: #a0a0a0}
i.fa-envelope{color: #0abb87}
.goto-page{width: 100px;text-align: center}
@media (max-width: 576px) {
    .items{
        margin-top: 5px; margin-bottom: 10px; position: relative;
    }
    .items [type=search]{width:150px}
    #ordersFilter strong{width:100%; display: block}
}
button > .fa-truck{
  margin-right: -2px;
}
a > .fa-money-check{
  font-size: 17px;
  margin-right: -2px;
}
a > .fa-times{
  margin-right: 3px;
}
a > .fa-check-circle{
  margin-right: -5px;
}
a > .fa-truck{
  margin-right: -9px;
  font-size: 17px;
}
button > .fa-ban{
  margin-right: 1px !important;
}
.is-middle{
  display: inline-flex;
  vertical-align: middle;
}
</style>
